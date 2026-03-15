/**
 * safe4337.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Safe + Safe4337Module ERC-4337 execution layer for HIEF Solver Network.
 *
 * Architecture (per HIEF_AI钱包执行层开发文档_基于Safe4337_v0.1):
 *   - Safe account acts as the smart wallet (asset control layer)
 *   - Safe4337Module (v0.3.0) acts as both ERC-4337 module AND fallback handler
 *   - UserOperation is constructed by AI, signed by user via MetaMask
 *   - EntryPoint v0.7 validates and executes the UserOp
 *
 * Flow:
 *   1. AI builds UserOperation with Safe.execTransaction() as callData
 *   2. AI computes UserOp hash (EIP-4337 domain-separated)
 *   3. User signs UserOp hash via MetaMask (eth_signTypedData_v4)
 *   4. AI submits via EntryPoint.handleOps() → Safe4337Module.validateUserOp()
 *      → Safe.execTransaction() → settlement
 *
 * Key contracts (same address on all chains via CREATE2):
 *   Safe4337Module v0.3.0:  0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226
 *   SafeModuleSetup v0.3.0: 0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47
 *   EntryPoint v0.7:        0x0000000071727De22E5E9d8BAf0edAc6f37da032
 *
 * EntryPoint v0.7 uses "packed" UserOperation format (different from v0.6).
 */
import { ethers } from 'ethers';

// ─── Constants ────────────────────────────────────────────────────────────────

export const SAFE_4337_MODULE_V030  = '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226';
export const SAFE_MODULE_SETUP_V030 = '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47';
export const ENTRY_POINT_V07        = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
export const SAFE_L2_V141           = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
export const SAFE_PROXY_FACTORY_V141 = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';

// EntryPoint v0.7 uses PackedUserOperation
const ENTRY_POINT_V07_ABI = [
  // handleOps with PackedUserOperation
  `function handleOps(
    tuple(
      address sender,
      uint256 nonce,
      bytes initCode,
      bytes callData,
      bytes32 accountGasLimits,
      uint256 preVerificationGas,
      bytes32 gasFees,
      bytes paymasterAndData,
      bytes signature
    )[] ops,
    address payable beneficiary
  ) external`,
  // getUserOpHash with PackedUserOperation
  `function getUserOpHash(
    tuple(
      address sender,
      uint256 nonce,
      bytes initCode,
      bytes callData,
      bytes32 accountGasLimits,
      uint256 preVerificationGas,
      bytes32 gasFees,
      bytes paymasterAndData,
      bytes signature
    ) userOp
  ) external view returns (bytes32)`,
  'function getNonce(address sender, uint192 key) external view returns (uint256 nonce)',
  'function balanceOf(address account) external view returns (uint256)',
  'function depositTo(address account) external payable',
];

const SAFE_ABI = [
  'function isModuleEnabled(address module) external view returns (bool)',
  'function getOwners() external view returns (address[])',
  'function getThreshold() external view returns (uint256)',
  'function nonce() external view returns (uint256)',
  // execTransaction — called as the inner call inside UserOp
  `function execTransaction(
    address to,
    uint256 value,
    bytes calldata data,
    uint8 operation,
    uint256 safeTxGas,
    uint256 baseGas,
    uint256 gasPrice,
    address gasToken,
    address payable refundReceiver,
    bytes memory signatures
  ) payable returns (bool success)`,
];

const SAFE_4337_MODULE_ABI = [
  'function SUPPORTED_ENTRYPOINT() external view returns (address)',
  'function domainSeparator() external view returns (bytes32)',
  // executeUserOp — alternative to execTransaction for ERC-4337 path
  'function executeUserOp(address to, uint256 value, bytes calldata data, uint8 operation) external',
  'function executeUserOpWithErrorString(address to, uint256 value, bytes calldata data, uint8 operation) external',
];

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * PackedUserOperation (EntryPoint v0.7 format).
 * accountGasLimits = abi.encodePacked(verificationGasLimit(16 bytes), callGasLimit(16 bytes))
 * gasFees          = abi.encodePacked(maxPriorityFeePerGas(16 bytes), maxFeePerGas(16 bytes))
 */
export interface PackedUserOperation {
  sender:              string;
  nonce:               bigint;
  initCode:            string;   // '0x' if already deployed
  callData:            string;
  accountGasLimits:    string;   // bytes32: verificationGasLimit(16) + callGasLimit(16)
  preVerificationGas:  bigint;
  gasFees:             string;   // bytes32: maxPriorityFeePerGas(16) + maxFeePerGas(16)
  paymasterAndData:    string;   // '0x' for no paymaster
  signature:           string;
}

export interface Safe4337ExecutionResult {
  userOpHash:   string;
  txHash:       string;
  blockNumber:  number;
  gasUsed:      number;
  safeAddress:  string;
  entryPoint:   string;
}

export interface Safe4337AccountInfo {
  safeAddress:      string;
  owners:           string[];
  threshold:        number;
  safeNonce:        bigint;
  entryPointNonce:  bigint;
  entryPoint:       string;
  moduleEnabled:    boolean;
  deposit:          bigint;
}

// ─── Helper: pack gas limits into bytes32 ────────────────────────────────────

function packGasLimits(verificationGasLimit: bigint, callGasLimit: bigint): string {
  // bytes32 = verificationGasLimit (16 bytes, upper) + callGasLimit (16 bytes, lower)
  const packed = (verificationGasLimit << 128n) | callGasLimit;
  return ethers.zeroPadValue(ethers.toBeHex(packed), 32);
}

function packGasFees(maxPriorityFeePerGas: bigint, maxFeePerGas: bigint): string {
  // bytes32 = maxPriorityFeePerGas (16 bytes, upper) + maxFeePerGas (16 bytes, lower)
  const packed = (maxPriorityFeePerGas << 128n) | maxFeePerGas;
  return ethers.zeroPadValue(ethers.toBeHex(packed), 32);
}

// ─── Safe4337AccountInfo ──────────────────────────────────────────────────────

/**
 * Query all relevant state for a Safe4337 account.
 */
export async function getSafe4337AccountInfo(
  safeAddress: string,
  rpcUrl: string
): Promise<Safe4337AccountInfo> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const safe = new ethers.Contract(safeAddress, SAFE_ABI, provider);
  const ep = new ethers.Contract(ENTRY_POINT_V07, ENTRY_POINT_V07_ABI, provider);

  const [owners, threshold, safeNonce, entryPointNonce, moduleEnabled, deposit] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
    safe.nonce(),
    ep.getNonce(safeAddress, 0),
    safe.isModuleEnabled(SAFE_4337_MODULE_V030),
    ep.balanceOf(safeAddress),
  ]);

  return {
    safeAddress,
    owners: owners as string[],
    threshold: Number(threshold),
    safeNonce,
    entryPointNonce,
    entryPoint: ENTRY_POINT_V07,
    moduleEnabled,
    deposit,
  };
}

// ─── Detect if a Safe has Safe4337Module enabled ──────────────────────────────

/**
 * Check if a Safe address has Safe4337Module enabled as both module and fallback handler.
 * This is the detection function used by detectAccountMode() in safeMultisig.ts.
 */
export async function isSafe4337Account(
  address: string,
  rpcUrl: string
): Promise<boolean> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    const safe = new ethers.Contract(address, SAFE_ABI, provider);
    const isEnabled = await safe.isModuleEnabled(SAFE_4337_MODULE_V030);
    if (!isEnabled) return false;

    // Also verify fallback handler is Safe4337Module
    const FALLBACK_HANDLER_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
    const raw = await provider.getStorage(address, FALLBACK_HANDLER_SLOT);
    const fallbackHandler = '0x' + raw.slice(26).toLowerCase();
    return fallbackHandler === SAFE_4337_MODULE_V030.toLowerCase();
  } catch {
    return false;
  }
}

// ─── Build UserOperation ──────────────────────────────────────────────────────

/**
 * Build a PackedUserOperation for Safe4337Module (EntryPoint v0.7).
 *
 * The callData is Safe4337Module.executeUserOp(to, value, data, operation)
 * which is called via the fallback handler mechanism.
 *
 * Note: We use executeUserOp() instead of Safe.execTransaction() because:
 *   - Safe4337Module intercepts calls to the Safe via the fallback handler
 *   - executeUserOp() is the ERC-4337 native execution path
 *   - It avoids the need for a separate Safe signature inside the UserOp
 */
export async function buildSafe4337UserOperation(params: {
  safeAddress:  string;
  to:           string;
  value:        bigint | string | number;
  data:         string;
  operation?:   0 | 1;   // 0 = Call, 1 = DelegateCall (default: 0)
  rpcUrl:       string;
}): Promise<PackedUserOperation> {
  const { safeAddress, to, rpcUrl } = params;
  const value = BigInt(params.value ?? 0);
  const data = params.data || '0x';
  const operation: 0 | 1 = params.operation ?? 0;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const ep = new ethers.Contract(ENTRY_POINT_V07, ENTRY_POINT_V07_ABI, provider);

  // Get current nonce from EntryPoint
  const nonce = await ep.getNonce(safeAddress, 0);

  // Encode callData: Safe4337Module.executeUserOp(to, value, data, operation)
  const moduleIface = new ethers.Interface(SAFE_4337_MODULE_ABI);
  const callData = moduleIface.encodeFunctionData('executeUserOp', [to, value, data, operation]);

  // Get current gas price
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits('20', 'gwei');
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei');

  // Gas limits for Safe4337 execution.
  // callGasLimit must cover the full inner call chain:
  //   executeUserOp → execTransactionFromModule → MultiSend → approve + supply
  // Aave USDC approve+supply takes ~260k gas, so 500k gives comfortable headroom.
  const verificationGasLimit = 150_000n;
  const callGasLimit = 500_000n;
  const preVerificationGas = 50_000n;

  const userOp: PackedUserOperation = {
    sender:             safeAddress,
    nonce,
    initCode:           '0x',
    callData,
    accountGasLimits:   packGasLimits(verificationGasLimit, callGasLimit),
    preVerificationGas,
    gasFees:            packGasFees(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData:   '0x',
    signature:          '0x',  // filled in after signing
  };

  return userOp;
}

// ─── Compute UserOp Hash ──────────────────────────────────────────────────────

/**
 * Compute the UserOp hash that the user must sign.
 * Uses EntryPoint.getUserOpHash() for correctness.
 */
export async function computeUserOpHash(
  userOp: PackedUserOperation,
  rpcUrl: string
): Promise<string> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const ep = new ethers.Contract(ENTRY_POINT_V07, ENTRY_POINT_V07_ABI, provider);

  // Convert to tuple format for the contract call
  const userOpTuple = [
    userOp.sender,
    userOp.nonce,
    userOp.initCode,
    userOp.callData,
    userOp.accountGasLimits,
    userOp.preVerificationGas,
    userOp.gasFees,
    userOp.paymasterAndData,
    userOp.signature,
  ];

  const hash = await ep.getUserOpHash(userOpTuple);
  return hash;
}

// ─── Build EIP-712 TypedData for MetaMask ────────────────────────────────────

/**
 * The 12-byte timestamp prefix required by Safe4337Module.
 * Safe4337Module._getSafeOp() expects:
 *   userOp.signature = abi.encodePacked(validAfter(6 bytes), validUntil(6 bytes), ecdsaSignature)
 * We use validAfter=0 and validUntil=0 (no time restriction).
 */
const SAFE_OP_TIMESTAMP_PREFIX = '0x' + '00'.repeat(12); // 12 zero bytes

/**
 * Wrap a raw ECDSA signature with the Safe4337Module timestamp prefix.
 * Safe4337Module._getSafeOp() decodes: sig[0:6]=validAfter, sig[6:12]=validUntil, sig[12:]=ecdsaSignature
 */
export function wrapSafe4337Signature(ecdsaSignature: string): string {
  // Remove '0x' prefix from the ECDSA signature and prepend 12 zero bytes
  const sigHex = ecdsaSignature.startsWith('0x') ? ecdsaSignature.slice(2) : ecdsaSignature;
  return SAFE_OP_TIMESTAMP_PREFIX + sigHex;
}

/**
 * Build the EIP-712 typed data structure for MetaMask to sign.
 *
 * Safe4337Module v0.3.0 uses SafeOp EIP-712 domain:
 *   - chainId: <chain>
 *   - verifyingContract: SAFE_4337_MODULE_V030  (the MODULE address, NOT the Safe)
 *
 * The type is SafeOp which matches the SAFE_OP_TYPEHASH:
 *   keccak256("SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,
 *     uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,
 *     uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes paymasterAndData,
 *     uint48 validAfter,uint48 validUntil,address entryPoint)")
 *
 * The MetaMask signature (65 bytes) must be prefixed with 12 zero bytes
 * (validAfter=0, validUntil=0) before being placed in userOp.signature.
 */
export async function buildUserOpTypedData(
  userOp: PackedUserOperation,
  userOpHash: string,
  chainId: number,
  _rpcUrl?: string   // kept for API compatibility, no longer used (trust SETTLEMENT_CHAIN_ID)
): Promise<{
  domain:      Record<string, unknown>;
  types:       Record<string, unknown[]>;
  message:     Record<string, unknown>;
  primaryType: string;
}> {
  // Use the explicitly configured chainId (SETTLEMENT_CHAIN_ID).
  // Previously we fetched chainId from the RPC, but Tenderly virtual testnets can return
  // the underlying mainnet chainId (1) instead of the fork chainId (e.g. 99917), causing
  // MetaMask to reject the signing request with "chainId should be same as current chainId".
  const actualChainId = chainId;

  // Safe4337Module v0.3.0 domain: only chainId + verifyingContract (the MODULE address)
  //
  // CRITICAL FIX: verifyingContract MUST be the Safe4337Module address, NOT the Safe address.
  //
  // Why: Safe4337Module.domainSeparator() uses address(this). When validateUserOp is called
  // via the Safe's fallback handler (CALL, not DELEGATECALL), address(this) in the module
  // equals the MODULE address. Therefore the EIP-712 domain separator uses MODULE as
  // verifyingContract, and we must sign with the same MODULE address.
  //
  // Verified on Tenderly fork: signing with verifyingContract=MODULE + Safe owner key
  // produces validateUserOp=0 (success) and handleOps succeeds with UserOperationEvent.success=true.
  const domain = {
    chainId: actualChainId,
    verifyingContract: SAFE_4337_MODULE_V030,  // MODULE address, not Safe address
  };

  // CRITICAL: The type name MUST be 'SafeOp' to match SAFE_OP_TYPEHASH in Safe4337Module v0.3.0:
  // keccak256("SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,uint128 verificationGasLimit,
  //   uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,
  //   bytes paymasterAndData,uint48 validAfter,uint48 validUntil,address entryPoint)")
  // = 0xc03dfc11d8b10bf9cf703d558958c8c42777f785d998c62060d85a4f0ef6ea7f
  // MetaMask v11+ requires EIP712Domain to be explicitly listed in types
  const types = {
    EIP712Domain: [
      { name: 'chainId',            type: 'uint256' },
      { name: 'verifyingContract',  type: 'address' },
    ],
    SafeOp: [
      { name: 'safe',                 type: 'address' },
      { name: 'nonce',                type: 'uint256' },
      { name: 'initCode',             type: 'bytes'   },
      { name: 'callData',             type: 'bytes'   },
      { name: 'verificationGasLimit', type: 'uint128' },
      { name: 'callGasLimit',         type: 'uint128' },
      { name: 'preVerificationGas',   type: 'uint256' },
      { name: 'maxPriorityFeePerGas', type: 'uint128' },
      { name: 'maxFeePerGas',         type: 'uint128' },
      { name: 'paymasterAndData',     type: 'bytes'   },
      { name: 'validAfter',           type: 'uint48'  },
      { name: 'validUntil',           type: 'uint48'  },
      { name: 'entryPoint',           type: 'address' },
    ],
  };

  // Unpack accountGasLimits: bytes32 = verificationGasLimit(16 bytes upper) + callGasLimit(16 bytes lower)
  const accountGasLimitsBig = BigInt(userOp.accountGasLimits);
  const verificationGasLimit = accountGasLimitsBig >> 128n;
  const callGasLimit = accountGasLimitsBig & ((1n << 128n) - 1n);

  // Unpack gasFees: bytes32 = maxPriorityFeePerGas(16 bytes upper) + maxFeePerGas(16 bytes lower)
  const gasFeesBig = BigInt(userOp.gasFees);
  const maxPriorityFeePerGas = gasFeesBig >> 128n;
  const maxFeePerGas = gasFeesBig & ((1n << 128n) - 1n);

  const message = {
    safe:                 userOp.sender,
    nonce:                userOp.nonce.toString(),
    initCode:             userOp.initCode,
    callData:             userOp.callData,
    verificationGasLimit: verificationGasLimit.toString(),
    callGasLimit:         callGasLimit.toString(),
    preVerificationGas:   userOp.preVerificationGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    maxFeePerGas:         maxFeePerGas.toString(),
    paymasterAndData:     userOp.paymasterAndData,
    validAfter:           '0',
    validUntil:           '0',
    entryPoint:           ENTRY_POINT_V07,
  };

  return { domain, types, message, primaryType: 'SafeOp' };
}

// ─── Sign UserOp (server-side, AI key) ───────────────────────────────────────

/**
 * Sign the UserOp hash with the AI's private key.
 * Safe4337Module v0.3.0 expects a raw ECDSA signature over the SafeUserOperation hash.
 * We use signTypedData to produce the correct EIP-712 signature.
 */
export async function signUserOpWithAI(
  userOp: PackedUserOperation,
  chainId: number,
  aiPrivateKey: string,
  rpcUrl?: string   // Optional: pass to fetch actual chainId from RPC
): Promise<string> {
  const aiWallet = new ethers.Wallet(aiPrivateKey);

  const { domain, types, message } = await buildUserOpTypedData(userOp, '', chainId, rpcUrl);

  // ethers.js handles the domain separator itself — strip EIP712Domain from types
  const typesForSigning = { ...types } as Record<string, unknown[]>;
  delete typesForSigning.EIP712Domain;

  // Sign using EIP-712 — produces 65-byte ECDSA signature
  const ecdsaSignature = await aiWallet.signTypedData(
    domain as ethers.TypedDataDomain,
    typesForSigning as Record<string, ethers.TypedDataField[]>,
    message
  );

  // Safe4337Module requires: abi.encodePacked(validAfter(6), validUntil(6), ecdsaSignature)
  return wrapSafe4337Signature(ecdsaSignature);
}

// ─── Submit UserOperation ─────────────────────────────────────────────────────

/**
 * Submit the signed UserOperation via EntryPoint.handleOps().
 * This bypasses the bundler and submits directly (suitable for Tenderly fork).
 */
export async function submitSafe4337UserOp(params: {
  userOp:       PackedUserOperation;
  rpcUrl:       string;
  submitterKey: string;  // AI key (pays gas for handleOps)
}): Promise<Safe4337ExecutionResult> {
  const { userOp, rpcUrl, submitterKey } = params;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const submitter = new ethers.Wallet(submitterKey, provider);
  const ep = new ethers.Contract(ENTRY_POINT_V07, ENTRY_POINT_V07_ABI, submitter);

  // Compute userOpHash for reference
  const userOpHash = await computeUserOpHash(userOp, rpcUrl);

  // Convert to tuple
  const userOpTuple = [
    userOp.sender,
    userOp.nonce,
    userOp.initCode,
    userOp.callData,
    userOp.accountGasLimits,
    userOp.preVerificationGas,
    userOp.gasFees,
    userOp.paymasterAndData,
    userOp.signature,
  ];

  // Submit via handleOps (dynamic gas estimation)
  let handleOpsGasLimit: bigint;
  try {
    const estimated = await ep.handleOps.estimateGas([userOpTuple], submitter.address);
    handleOpsGasLimit = estimated * 125n / 100n;
    console.log(`[Safe4337] Gas estimated: ${estimated} → using ${handleOpsGasLimit}`);
  } catch (estErr: any) {
    const reason = estErr?.info?.error?.message ?? estErr?.message ?? String(estErr);
    throw new Error(`Safe4337 handleOps gas estimation failed: ${reason.slice(0, 300)}`);
  }

  const tx = await ep.handleOps([userOpTuple], submitter.address, {
    gasLimit: handleOpsGasLimit,
  });

  const receipt = await tx.wait();

  // Check for UserOperationEvent
  const userOpEventTopic = ethers.id('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)');
  const userOpLog = receipt.logs.find((l: { topics: string[] }) => l.topics[0] === userOpEventTopic);

  if (userOpLog) {
    // Decode: UserOperationEvent(bytes32 userOpHash, address sender, address paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)
    // UserOperationEvent v0.7: topics[1]=userOpHash, topics[2]=sender, topics[3]=paymaster
    // data = abi.encode(nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ['uint256', 'bool', 'uint256', 'uint256'],
      userOpLog.data
    );
    const success = decoded[1] as boolean;
    if (!success) {
      throw new Error(`UserOperation failed on-chain. UserOpHash: ${userOpHash} | handleOps txHash: ${receipt.hash}`);
    }
  }

  return {
    userOpHash,
    txHash:      receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed:     Number(receipt.gasUsed),
    safeAddress: userOp.sender,
    entryPoint:  ENTRY_POINT_V07,
  };
}

// ─── Full E2E Execution ───────────────────────────────────────────────────────

/**
 * Full Safe4337 execution flow (used by server.ts after user signature is collected):
 *   1. Attach user signature to UserOp
 *   2. Submit via EntryPoint.handleOps()
 *   3. Return execution result
 */
export async function executeSafe4337WithSignature(params: {
  userOp:        PackedUserOperation;
  userSignature: string;  // MetaMask EIP-712 signature from user (raw 65-byte ECDSA)
  rpcUrl:        string;
  submitterKey:  string;  // AI key for gas payment
}): Promise<Safe4337ExecutionResult> {
  const { userOp, userSignature, rpcUrl, submitterKey } = params;

  // Wrap the user's ECDSA signature with Safe4337Module timestamp prefix
  // Safe4337Module._getSafeOp() expects: abi.encodePacked(validAfter(6), validUntil(6), ecdsaSignature)
  const wrappedSignature = wrapSafe4337Signature(userSignature);

  // Attach the wrapped signature to the UserOp
  const signedUserOp: PackedUserOperation = {
    ...userOp,
    signature: wrappedSignature,
  };

  return submitSafe4337UserOp({ userOp: signedUserOp, rpcUrl, submitterKey });
}

// ─── Deploy new Safe with Safe4337Module ─────────────────────────────────────

/**
 * Deploy a new Safe proxy with Safe4337Module enabled.
 * Used for onboarding new users who don't have a Safe4337 account yet.
 */
export async function deployNewSafe4337Account(params: {
  owners:     string[];
  threshold:  number;
  saltNonce:  bigint;
  rpcUrl:     string;
  deployerKey: string;
}): Promise<string> {
  const { owners, threshold, saltNonce, rpcUrl, deployerKey } = params;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deployer = new ethers.Wallet(deployerKey, provider);

  const SAFE_PROXY_FACTORY_ABI_DEPLOY = [
    'function createProxyWithNonce(address _singleton, bytes memory initializer, uint256 saltNonce) external returns (address proxy)',
    'function proxyCreationCode() external pure returns (bytes memory)',
  ];
  const SAFE_SETUP_ABI = [
    'function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver) external',
  ];
  const SAFE_MODULE_SETUP_ABI_LOCAL = [
    'function enableModules(address[] calldata modules) external',
  ];

  const moduleSetupIface = new ethers.Interface(SAFE_MODULE_SETUP_ABI_LOCAL);
  const enableModulesData = moduleSetupIface.encodeFunctionData('enableModules', [
    [SAFE_4337_MODULE_V030],
  ]);

  const safeIface = new ethers.Interface(SAFE_SETUP_ABI);
  const setupData = safeIface.encodeFunctionData('setup', [
    owners,
    threshold,
    SAFE_MODULE_SETUP_V030,
    enableModulesData,
    SAFE_4337_MODULE_V030,
    ethers.ZeroAddress,
    0,
    ethers.ZeroAddress,
  ]);

  const factory = new ethers.Contract(SAFE_PROXY_FACTORY_V141, SAFE_PROXY_FACTORY_ABI_DEPLOY, deployer);
  const deployGasLimit4337 = await factory.createProxyWithNonce.estimateGas(SAFE_L2_V141, setupData, saltNonce)
    .then((e: bigint) => e * 125n / 100n)
    .catch(() => 500_000n);
  const tx = await factory.createProxyWithNonce(SAFE_L2_V141, setupData, saltNonce, { gasLimit: deployGasLimit4337 });
  const receipt = await tx.wait();

  // Extract address from ProxyCreation event
  const proxyCreationTopic = ethers.id('ProxyCreation(address,address)');
  const log = receipt.logs.find((l: { topics: string[] }) => l.topics[0] === proxyCreationTopic);
  if (!log) throw new Error('ProxyCreation event not found');

  const safeAddress = ethers.AbiCoder.defaultAbiCoder().decode(['address'], log.topics[1])[0] as string;
  return safeAddress;
}

// ─── Deploy new plain Safe Multisig ──────────────────────────────────────────

/**
 * Deploy a new Safe proxy as a 2-of-2 multisig.
 * Owners: [userAddress, deployerAddress (AI key)]
 * Threshold: 2 — both must co-sign transactions.
 */
export async function deployNewSafeMultisig(params: {
  userAddress: string;
  saltNonce:   bigint;
  rpcUrl:      string;
  deployerKey: string;
}): Promise<string> {
  const { userAddress, saltNonce, rpcUrl, deployerKey } = params;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deployer = new ethers.Wallet(deployerKey, provider);

  const SAFE_PROXY_FACTORY_ABI_DEPLOY = [
    'function createProxyWithNonce(address _singleton, bytes memory initializer, uint256 saltNonce) external returns (address proxy)',
  ];
  const SAFE_SETUP_ABI = [
    'function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver) external',
  ];

  const safeIface = new ethers.Interface(SAFE_SETUP_ABI);
  const setupData = safeIface.encodeFunctionData('setup', [
    [userAddress, deployer.address],  // 2 owners: user + AI
    2,                                // threshold = 2 (both must sign)
    ethers.ZeroAddress,
    '0x',
    ethers.ZeroAddress,               // no fallback handler for plain Safe
    ethers.ZeroAddress,
    0,
    ethers.ZeroAddress,
  ]);

  const factory = new ethers.Contract(SAFE_PROXY_FACTORY_V141, SAFE_PROXY_FACTORY_ABI_DEPLOY, deployer);
  const deployGasLimitMultisig = await factory.createProxyWithNonce.estimateGas(SAFE_L2_V141, setupData, saltNonce)
    .then((e: bigint) => e * 125n / 100n)
    .catch(() => 500_000n);
  const tx = await factory.createProxyWithNonce(SAFE_L2_V141, setupData, saltNonce, { gasLimit: deployGasLimitMultisig });
  const receipt = await tx.wait();

  const proxyCreationTopic = ethers.id('ProxyCreation(address,address)');
  const log = receipt.logs.find((l: { topics: string[] }) => l.topics[0] === proxyCreationTopic);
  if (!log) throw new Error('ProxyCreation event not found');

  return ethers.AbiCoder.defaultAbiCoder().decode(['address'], log.topics[1])[0] as string;
}
