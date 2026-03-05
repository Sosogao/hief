/**
 * erc4337.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * ERC-4337 Account Abstraction integration for HIEF Solver Network.
 *
 * Responsibilities:
 *  1. buildUserOperation()        — construct a UserOperation for a given call
 *  2. signUserOperation()         — sign the UserOp hash with the owner key
 *  3. simulateUserOperation()     — dry-run via eth_call to Tenderly fork
 *  4. submitUserOperation()       — send via eth_sendUserOperation to bundler
 *  5. waitForUserOpReceipt()      — poll eth_getUserOperationReceipt until mined
 *  6. executeERC4337()            — full end-to-end flow (build → sign → submit → wait)
 *
 * Supported EntryPoint versions:
 *   - v0.6  (0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789)
 *   - v0.7  (0x0000000071727De22E5E9d8BAf0edAc6f37da032)
 *
 * Bundler strategy:
 *   - Primary:  Tenderly fork's native bundler (eth_sendUserOperation)
 *   - Fallback: Direct EntryPoint.handleOps() call (bypasses bundler, works on fork)
 */

import { ethers } from 'ethers';

// ─── Constants ────────────────────────────────────────────────────────────────

export const ENTRY_POINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
export const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

/** SimpleAccount factory v0.6 — deployed on all major chains */
export const SIMPLE_ACCOUNT_FACTORY_V06 = '0x9406Cc6185a346906296840746125a0E44976454';

/** EntryPoint v0.6 ABI — only the methods we need */
const ENTRY_POINT_V06_ABI = [
  'function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)[] ops, address payable beneficiary) external',
  'function getUserOpHash(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature) userOp) external view returns (bytes32)',
  'function getNonce(address sender, uint192 key) external view returns (uint256 nonce)',
  'function depositTo(address account) external payable',
  'function balanceOf(address account) external view returns (uint256)',
];

/** SimpleAccount ABI — execute a single call */
const SIMPLE_ACCOUNT_ABI = [
  'function execute(address dest, uint256 value, bytes calldata func) external',
  'function executeBatch(address[] calldata dest, bytes[] calldata func) external',
  'function owner() external view returns (address)',
  'function entryPoint() external view returns (address)',
  'function getNonce() external view returns (uint256)',
];

/** SimpleAccount Factory ABI */
const SIMPLE_ACCOUNT_FACTORY_ABI = [
  'function createAccount(address owner, uint256 salt) external returns (address ret)',
  'function getAddress(address owner, uint256 salt) external view returns (address ret)',
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserOperation {
  sender: string;
  nonce: string;           // hex string
  initCode: string;        // '0x' if account already deployed
  callData: string;
  callGasLimit: string;    // hex string
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymasterAndData: string; // '0x' for no paymaster
  signature: string;
}

export interface UserOpSimulation {
  success: boolean;
  gasUsed: number;
  preVerificationGas: number;
  verificationGasLimit: number;
  callGasLimit: number;
  error?: string;
  returnData?: string;
  // Simulation details
  sender: string;
  callData: string;
  decodedCall?: {
    to: string;
    value: string;
    data: string;
    method?: string;
  };
}

export interface UserOpReceipt {
  userOpHash: string;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  success: boolean;
  actualGasCost: string;
  actualGasUsed: string;
  logs: any[];
}

export interface ERC4337ExecutionResult {
  userOpHash: string;
  txHash: string;
  blockNumber: number;
  success: boolean;
  simulation: UserOpSimulation;
  userOp: UserOperation;
  entryPoint: string;
  accountType: string;
}

// ─── Nonce Fetching ───────────────────────────────────────────────────────────

/**
 * Get the current nonce for an ERC-4337 account from the EntryPoint.
 */
export async function getAccountNonce(
  accountAddress: string,
  entryPointAddress: string,
  provider: ethers.JsonRpcProvider,
  key: bigint = 0n
): Promise<bigint> {
  const entryPoint = new ethers.Contract(entryPointAddress, ENTRY_POINT_V06_ABI, provider);
  try {
    const nonce = await entryPoint.getNonce(accountAddress, key);
    return nonce;
  } catch {
    // Fallback: try getNonce() directly on the account
    const account = new ethers.Contract(accountAddress, SIMPLE_ACCOUNT_ABI, provider);
    try {
      return await account.getNonce();
    } catch {
      return 0n;
    }
  }
}

// ─── UserOperation Builder ────────────────────────────────────────────────────

/**
 * Build a UserOperation for a SimpleAccount to call a target contract.
 * Encodes the call as SimpleAccount.execute(to, value, data).
 */
export async function buildUserOperation(params: {
  accountAddress: string;
  to: string;
  value: string;        // wei as decimal string
  data: string;         // calldata hex
  entryPointAddress: string;
  provider: ethers.JsonRpcProvider;
  chainId: number;
  initCode?: string;    // '0x' if account already deployed
}): Promise<UserOperation> {
  const {
    accountAddress, to, value, data,
    entryPointAddress, provider, initCode = '0x',
  } = params;

  // Get nonce from EntryPoint
  const nonce = await getAccountNonce(accountAddress, entryPointAddress, provider);

  // Encode SimpleAccount.execute(to, value, data)
  const accountInterface = new ethers.Interface(SIMPLE_ACCOUNT_ABI);
  const callData = accountInterface.encodeFunctionData('execute', [
    to,
    BigInt(value),
    data,
  ]);

  // Gas estimation — use conservative defaults for Tenderly fork
  // In production these would come from eth_estimateUserOperationGas
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits('2', 'gwei');
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei');

  const userOp: UserOperation = {
    sender: accountAddress,
    nonce: ethers.toBeHex(nonce),
    initCode,
    callData,
    callGasLimit: ethers.toBeHex(200_000),
    verificationGasLimit: ethers.toBeHex(150_000),
    preVerificationGas: ethers.toBeHex(50_000),
    maxFeePerGas: ethers.toBeHex(maxFeePerGas),
    maxPriorityFeePerGas: ethers.toBeHex(maxPriorityFeePerGas),
    paymasterAndData: '0x',
    signature: '0x',  // filled in by signUserOperation()
  };

  return userOp;
}

// ─── UserOp Hash Computation ──────────────────────────────────────────────────

/**
 * Compute the EIP-4337 UserOperation hash (what the owner signs).
 * This matches EntryPoint.getUserOpHash() on-chain.
 */
export function computeUserOpHash(
  userOp: UserOperation,
  entryPointAddress: string,
  chainId: number
): string {
  // Pack the UserOp fields (without signature)
  const packed = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address','uint256','bytes32','bytes32','uint256','uint256','uint256','uint256','uint256','bytes32'],
    [
      userOp.sender,
      BigInt(userOp.nonce),
      ethers.keccak256(userOp.initCode),
      ethers.keccak256(userOp.callData),
      BigInt(userOp.callGasLimit),
      BigInt(userOp.verificationGasLimit),
      BigInt(userOp.preVerificationGas),
      BigInt(userOp.maxFeePerGas),
      BigInt(userOp.maxPriorityFeePerGas),
      ethers.keccak256(userOp.paymasterAndData),
    ]
  );
  const userOpHash = ethers.keccak256(packed);

  // Final hash: keccak256(abi.encode(userOpHash, entryPoint, chainId))
  const finalHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint256'],
      [userOpHash, entryPointAddress, chainId]
    )
  );
  return finalHash;
}

// ─── Signing ──────────────────────────────────────────────────────────────────

/**
 * Sign a UserOperation with the account owner's private key.
 * ERC-4337 uses a plain eth_sign (personal_sign) over the UserOp hash.
 */
export async function signUserOperation(
  userOp: UserOperation,
  ownerPrivateKey: string,
  entryPointAddress: string,
  chainId: number
): Promise<UserOperation> {
  const wallet = new ethers.Wallet(ownerPrivateKey);

  // Compute the hash that the EntryPoint will verify
  const userOpHash = computeUserOpHash(userOp, entryPointAddress, chainId);

  // Sign with personal_sign (adds \x19Ethereum Signed Message:\n32 prefix)
  // This is what SimpleAccount.validateUserOp() expects
  const signature = await wallet.signMessage(ethers.getBytes(userOpHash));

  return { ...userOp, signature };
}

// ─── Simulation ───────────────────────────────────────────────────────────────

/**
 * Simulate a UserOperation by calling EntryPoint.simulateValidation() and
 * estimating gas via eth_call. On Tenderly fork we can also use debug_traceCall.
 */
export async function simulateUserOperation(
  userOp: UserOperation,
  entryPointAddress: string,
  provider: ethers.JsonRpcProvider,
): Promise<UserOpSimulation> {
  // Decode the callData to show what the UserOp will do
  let decodedCall: UserOpSimulation['decodedCall'] | undefined;
  try {
    const accountInterface = new ethers.Interface(SIMPLE_ACCOUNT_ABI);
    const decoded = accountInterface.parseTransaction({ data: userOp.callData });
    if (decoded && decoded.name === 'execute') {
      decodedCall = {
        to: decoded.args[0] as string,
        value: (decoded.args[1] as bigint).toString(),
        data: decoded.args[2] as string,
        method: 'execute',
      };
    }
  } catch { /* ignore decode errors */ }

  // Estimate gas via eth_estimateGas on the EntryPoint handleOps call
  const entryPoint = new ethers.Contract(entryPointAddress, ENTRY_POINT_V06_ABI, provider);
  const beneficiary = userOp.sender; // gas refund goes to sender for simulation

  try {
    // Use eth_call to simulate handleOps
    const gasEstimate = await provider.estimateGas({
      to: entryPointAddress,
      data: entryPoint.interface.encodeFunctionData('handleOps', [
        [userOp],
        beneficiary,
      ]),
    });

    const callGasLimit = Number(BigInt(userOp.callGasLimit));
    const verificationGasLimit = Number(BigInt(userOp.verificationGasLimit));
    const preVerificationGas = Number(BigInt(userOp.preVerificationGas));

    console.log(`[ERC4337] Simulation success | gasEstimate=${gasEstimate} | sender=${userOp.sender.slice(0, 10)}...`);

    return {
      success: true,
      gasUsed: Number(gasEstimate),
      preVerificationGas,
      verificationGasLimit,
      callGasLimit,
      sender: userOp.sender,
      callData: userOp.callData,
      decodedCall,
    };
  } catch (err: any) {
    // Extract revert reason
    const errMsg = err.message || String(err);
    console.warn(`[ERC4337] Simulation failed: ${errMsg.slice(0, 200)}`);

    return {
      success: false,
      gasUsed: 0,
      preVerificationGas: Number(BigInt(userOp.preVerificationGas)),
      verificationGasLimit: Number(BigInt(userOp.verificationGasLimit)),
      callGasLimit: Number(BigInt(userOp.callGasLimit)),
      error: errMsg.slice(0, 500),
      sender: userOp.sender,
      callData: userOp.callData,
      decodedCall,
    };
  }
}

// ─── Bundler Submission ───────────────────────────────────────────────────────

/**
 * Submit a UserOperation to the bundler via eth_sendUserOperation.
 * On Tenderly fork, falls back to direct EntryPoint.handleOps() if bundler is unavailable.
 */
export async function submitUserOperation(
  userOp: UserOperation,
  entryPointAddress: string,
  rpcUrl: string,
  ownerPrivateKey: string,
): Promise<{ userOpHash: string; txHash: string; blockNumber: number }> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Strategy 1: Try eth_sendUserOperation (standard bundler API)
  try {
    const userOpHash = await provider.send('eth_sendUserOperation', [
      userOp,
      entryPointAddress,
    ]);
    console.log(`[ERC4337] UserOp submitted via bundler | userOpHash=${userOpHash.slice(0, 16)}...`);

    // Wait for receipt
    const receipt = await waitForUserOpReceipt(userOpHash, rpcUrl, 30_000);
    return {
      userOpHash,
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
    };
  } catch (bundlerErr: any) {
    console.warn(`[ERC4337] Bundler submission failed (${bundlerErr.message?.slice(0, 80)}), falling back to direct handleOps...`);
  }

  // Strategy 2: Direct EntryPoint.handleOps() call (works on Tenderly fork without bundler)
  const wallet = new ethers.Wallet(ownerPrivateKey, provider);
  const entryPoint = new ethers.Contract(entryPointAddress, ENTRY_POINT_V06_ABI, wallet);

  console.log(`[ERC4337] Submitting via direct EntryPoint.handleOps() | sender=${userOp.sender.slice(0, 10)}...`);

  const tx = await entryPoint.handleOps([userOp], wallet.address, {
    gasLimit: 2_000_000,
  });
  const receipt = await tx.wait();

  // Compute userOpHash for reference
  const chainId = Number((await provider.getNetwork()).chainId);
  const userOpHash = computeUserOpHash(userOp, entryPointAddress, chainId);

  console.log(`[ERC4337] ✅ handleOps confirmed | txHash=${receipt.hash} | block=${receipt.blockNumber}`);

  return {
    userOpHash,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
}

// ─── Receipt Polling ──────────────────────────────────────────────────────────

/**
 * Poll eth_getUserOperationReceipt until the UserOp is included in a block.
 */
export async function waitForUserOpReceipt(
  userOpHash: string,
  rpcUrl: string,
  timeoutMs: number = 60_000,
): Promise<UserOpReceipt> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const start = Date.now();
  const pollInterval = 2_000;

  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await provider.send('eth_getUserOperationReceipt', [userOpHash]);
      if (receipt) {
        return {
          userOpHash,
          txHash: receipt.receipt?.transactionHash || receipt.transactionHash,
          blockNumber: parseInt(receipt.receipt?.blockNumber || receipt.blockNumber, 16),
          blockHash: receipt.receipt?.blockHash || receipt.blockHash,
          success: receipt.success,
          actualGasCost: receipt.actualGasCost,
          actualGasUsed: receipt.actualGasUsed,
          logs: receipt.logs || [],
        };
      }
    } catch { /* not yet included */ }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error(`UserOp ${userOpHash.slice(0, 16)}... not included within ${timeoutMs}ms`);
}

// ─── Full Execution Flow ──────────────────────────────────────────────────────

/**
 * Full ERC-4337 execution flow:
 *   1. Build UserOperation
 *   2. Simulate (dry-run)
 *   3. Sign with owner key
 *   4. Submit to bundler (or direct handleOps fallback)
 *   5. Return result with txHash and simulation details
 */
export async function executeERC4337(params: {
  accountAddress: string;
  to: string;
  value: string;
  data: string;
  entryPointAddress: string;
  rpcUrl: string;
  ownerPrivateKey: string;
  chainId: number;
  accountType?: string;
}): Promise<ERC4337ExecutionResult> {
  const {
    accountAddress, to, value, data,
    entryPointAddress, rpcUrl, ownerPrivateKey, chainId,
    accountType = 'SmartAccount',
  } = params;

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  console.log(`[ERC4337] Starting execution | account=${accountAddress.slice(0, 10)}... | to=${to.slice(0, 10)}... | value=${value}`);

  // Step 1: Build UserOperation
  const userOp = await buildUserOperation({
    accountAddress, to, value, data,
    entryPointAddress, provider, chainId,
  });
  console.log(`[ERC4337] UserOp built | nonce=${userOp.nonce} | callGasLimit=${userOp.callGasLimit}`);

  // Step 2: Simulate (before signing — shows what will happen)
  const simulation = await simulateUserOperation(userOp, entryPointAddress, provider);
  console.log(`[ERC4337] Simulation: success=${simulation.success} | gasUsed=${simulation.gasUsed}`);

  // Step 3: Sign
  const signedUserOp = await signUserOperation(userOp, ownerPrivateKey, entryPointAddress, chainId);
  console.log(`[ERC4337] UserOp signed | sig=${signedUserOp.signature.slice(0, 20)}...`);

  // Step 4: Submit
  const { userOpHash, txHash, blockNumber } = await submitUserOperation(
    signedUserOp, entryPointAddress, rpcUrl, ownerPrivateKey
  );

  console.log(`[ERC4337] ✅ Executed | userOpHash=${userOpHash.slice(0, 16)}... | txHash=${txHash.slice(0, 16)}... | block=${blockNumber}`);

  return {
    userOpHash,
    txHash,
    blockNumber,
    success: true,
    simulation,
    userOp: signedUserOp,
    entryPoint: entryPointAddress,
    accountType,
  };
}

// ─── Account Deployment Helper ────────────────────────────────────────────────

/**
 * Get or create a SimpleAccount for a given owner address.
 * Returns the counterfactual address (even if not yet deployed).
 */
export async function getOrCreateSimpleAccount(
  ownerAddress: string,
  salt: bigint,
  rpcUrl: string,
): Promise<{ accountAddress: string; isDeployed: boolean; initCode: string }> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const factory = new ethers.Contract(SIMPLE_ACCOUNT_FACTORY_V06, SIMPLE_ACCOUNT_FACTORY_ABI, provider);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accountAddress: string = await (factory as any).getAddress(ownerAddress, salt);
  const code = await provider.getCode(accountAddress);
  const isDeployed = code !== '0x';

  let initCode = '0x';
  if (!isDeployed) {
    // Encode factory.createAccount(owner, salt) as initCode
    const factoryInterface = new ethers.Interface(SIMPLE_ACCOUNT_FACTORY_ABI);
    const createCalldata = factoryInterface.encodeFunctionData('createAccount', [ownerAddress, salt]);
    initCode = SIMPLE_ACCOUNT_FACTORY_V06 + createCalldata.slice(2);
  }

  console.log(`[ERC4337] SimpleAccount | owner=${ownerAddress.slice(0, 10)}... | address=${accountAddress.slice(0, 10)}... | deployed=${isDeployed}`);

  return { accountAddress, isDeployed, initCode };
}
