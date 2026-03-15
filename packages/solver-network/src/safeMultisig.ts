/**
 * safeMultisig.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Safe Multisig integration for HIEF Solver Network.
 *
 * Responsibilities:
 *  1. detectAccountMode()  — query chain to determine if an address is a Safe
 *                            with threshold ≥ 2 (MULTISIG) or a plain EOA/1-of-1 (DIRECT)
 *  2. proposeSafeMultisig() — after simulation, build & submit a Safe Transaction
 *                             to the Safe Transaction Service so co-signers can approve
 *
 * Execution Mode Logic:
 *   - If smartAccount has Safe threshold ≥ 2  → MULTISIG mode
 *   - Otherwise (EOA, AA wallet, threshold=1) → DIRECT mode (existing flow)
 */

import { ethers } from 'ethers';
import { isSafe4337Account, SAFE_4337_MODULE_V030, ENTRY_POINT_V07 as EP_V07 } from './safe4337';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExecutionMode = 'DIRECT' | 'MULTISIG' | 'ERC4337' | 'ERC4337_SAFE';

export interface AccountInfo {
  address: string;
  mode: ExecutionMode;
  threshold: number;       // 0 = EOA, 1 = single-owner Safe, ≥2 = multisig
  owners: string[];        // Safe owners (empty for EOA)
  isSafe: boolean;
  isERC4337: boolean;      // true if address is an ERC-4337 smart account
  isSafe4337: boolean;     // true if Safe + Safe4337Module enabled (ERC4337_SAFE mode)
  entryPoint?: string;     // EntryPoint contract address (ERC-4337 only)
  accountType?: string;    // e.g. 'Safe4337', 'SimpleAccount', 'KernelAccount'
}

export interface SafeProposalResult {
  safeTxHash: string;
  safeAddress: string;
  threshold: number;
  nonce: number;
  proposedAt: number;
  safeServiceUrl: string;
  signingUrl: string;      // Deep-link to Safe UI for co-signers
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimal Safe ABI — only the methods we need */
const SAFE_ABI = [
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function nonce() view returns (uint256)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) payable returns (bool success)',
];

/** Safe Transaction Service URLs by chainId */
const SAFE_TX_SERVICE: Record<number, string> = {
  1:     'https://safe-transaction-mainnet.safe.global',
  8453:  'https://safe-transaction-base.safe.global',
  84532: 'https://safe-transaction-base-sepolia.safe.global',
  99917: 'https://safe-transaction-base-sepolia.safe.global', // Tenderly fork → use Base Sepolia service
};

/** Safe UI base URL for signing */
const SAFE_UI_URL = 'https://app.safe.global';

// ─── Account Mode Detection ───────────────────────────────────────────────────

/**
 * Detect whether an address is:
 *   - Plain EOA                                → DIRECT mode
 *   - Safe with Safe4337Module enabled         → ERC4337_SAFE mode  ← NEW
 *   - Safe with threshold ≥ 2 (no 4337 module) → MULTISIG mode
 *   - Safe with threshold = 1 (no 4337 module) → DIRECT mode
 *   - Generic ERC-4337 smart account           → ERC4337 mode
 *   - Unknown contract                         → DIRECT (fallback)
 *
 * Detection order:
 *   1. No code → EOA → DIRECT
 *   2. Has Safe interface (getThreshold):
 *      a. Has Safe4337Module enabled → ERC4337_SAFE
 *      b. threshold ≥ 2             → MULTISIG
 *      c. threshold = 1             → DIRECT
 *   3. Has ERC-4337 interface (entryPoint()) → ERC4337
 *   4. Unknown contract → DIRECT (fallback)
 */
export async function detectAccountMode(
  address: string,
  rpcUrl: string,
  chainId: number
): Promise<AccountInfo> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // ERC-4337 EntryPoint addresses (v0.6 and v0.7)
  const ENTRY_POINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
  const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

  // Minimal ERC-4337 IAccount ABI — validateUserOp is the canonical identifier
  const ERC4337_ABI = [
    'function validateUserOp(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature) userOp, bytes32 userOpHash, uint256 missingAccountFunds) external returns (uint256 validationData)',
    'function entryPoint() external view returns (address)',
    'function getNonce() external view returns (uint256)',
  ];

  try {
    // Step 1: Check if address is a contract
    const code = await provider.getCode(address);
    if (code === '0x' || code === '') {
      // Plain EOA
      console.log(`[AccountDetect] ${address.slice(0, 10)}... → EOA → DIRECT`);
      return { address, mode: 'DIRECT', threshold: 0, owners: [], isSafe: false, isERC4337: false, isSafe4337: false };
    }

    // Step 2: Try Safe interface first
    const safeContract = new ethers.Contract(address, SAFE_ABI, provider);
    try {
      const [threshold, owners] = await Promise.all([
        safeContract.getThreshold(),
        safeContract.getOwners(),
      ]);
      const thresholdNum = Number(threshold);

      // Step 2a: Check if this Safe has Safe4337Module enabled → ERC4337_SAFE mode
      const has4337Module = await isSafe4337Account(address, rpcUrl);
      if (has4337Module) {
        console.log(`[AccountDetect] ${address.slice(0, 10)}... → Safe+Safe4337Module | threshold=${thresholdNum} | mode=ERC4337_SAFE`);
        return {
          address, mode: 'ERC4337_SAFE', threshold: thresholdNum,
          owners: owners as string[], isSafe: true, isERC4337: true, isSafe4337: true,
          entryPoint: EP_V07,
          accountType: 'Safe4337',
        };
      }

      // Step 2b/2c: Regular Safe — MULTISIG or DIRECT
      const mode: ExecutionMode = thresholdNum >= 2 ? 'MULTISIG' : 'DIRECT';
      console.log(`[AccountDetect] ${address.slice(0, 10)}... → Safe | threshold=${thresholdNum} | mode=${mode}`);
      return {
        address, mode, threshold: thresholdNum,
        owners: owners as string[], isSafe: true, isERC4337: false, isSafe4337: false,
      };
    } catch {
      // Not a Safe — continue to ERC-4337 detection
    }

    // Step 3: Try ERC-4337 interface
    const aaContract = new ethers.Contract(address, ERC4337_ABI, provider);
    try {
      // Try to read the entryPoint — this is a standard method on all ERC-4337 accounts
      const ep = await aaContract.entryPoint();
      const epLower = ep.toLowerCase();
      const isKnownEP = epLower === ENTRY_POINT_V06.toLowerCase() || epLower === ENTRY_POINT_V07.toLowerCase();
      const epVersion = epLower === ENTRY_POINT_V07.toLowerCase() ? 'v0.7' : 'v0.6';

      // Detect account type from bytecode patterns
      let accountType = 'SmartAccount';
      if (code.includes('5FF137D4')) accountType = 'SimpleAccount';
      else if (code.includes('d9cFb9A5')) accountType = 'KernelAccount';
      else if (code.includes('1195e8ef')) accountType = 'BiconomyAccount';

      console.log(`[AccountDetect] ${address.slice(0, 10)}... → ERC-4337 | entryPoint=${ep.slice(0, 10)}... (${epVersion}) | type=${accountType}`);
      return {
        address, mode: 'ERC4337', threshold: 1, owners: [],
        isSafe: false, isERC4337: true, isSafe4337: false,
        entryPoint: isKnownEP ? ep : ENTRY_POINT_V06,
        accountType,
      };
    } catch {
      // Not an ERC-4337 account either — unknown contract, default to DIRECT
    }

    // Step 4: Unknown contract — treat as DIRECT
    console.log(`[AccountDetect] ${address.slice(0, 10)}... → Unknown contract → DIRECT (fallback)`);
    return { address, mode: 'DIRECT', threshold: 1, owners: [], isSafe: false, isERC4337: false, isSafe4337: false };

  } catch (err: any) {
    console.warn(`[AccountDetect] Could not detect account mode for ${address}: ${err.message}`);
    return { address, mode: 'DIRECT', threshold: 0, owners: [], isSafe: false, isERC4337: false, isSafe4337: false };
  }
}

// ─── Safe Transaction Builder ─────────────────────────────────────────────────

/**
 * Build a Safe transaction data object.
 * operation=0 for regular CALL, operation=1 for DELEGATECALL (used with MultiSend).
 */
function buildSafeTxData(
  to: string,
  value: string,
  data: string,
  nonce: number,
  operation: 0 | 1 = 0,
) {
  return {
    to,
    value,
    data,
    operation,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce,
  };
}

/**
 * Compute the EIP-712 Safe transaction hash.
 */
function computeSafeTxHash(
  safeTx: ReturnType<typeof buildSafeTxData>,
  safeAddress: string,
  chainId: number
): string {
  const SAFE_TX_TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes(
      'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)'
    )
  );
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encodedTx = ethers.keccak256(
    coder.encode(
      ['bytes32','address','uint256','bytes32','uint8','uint256','uint256','uint256','address','address','uint256'],
      [
        SAFE_TX_TYPEHASH,
        safeTx.to,
        BigInt(safeTx.value),
        ethers.keccak256(safeTx.data),
        safeTx.operation,
        BigInt(safeTx.safeTxGas),
        BigInt(safeTx.baseGas),
        BigInt(safeTx.gasPrice),
        safeTx.gasToken,
        safeTx.refundReceiver,
        BigInt(safeTx.nonce),
      ]
    )
  );
  const DOMAIN_SEPARATOR_TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes('EIP712Domain(uint256 chainId,address verifyingContract)')
  );
  const domainSeparator = ethers.keccak256(
    coder.encode(
      ['bytes32','uint256','address'],
      [DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), safeAddress]
    )
  );
  return ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes('\x19\x01'),
      ethers.getBytes(domainSeparator),
      ethers.getBytes(encodedTx),
    ])
  );
}

// ─── Safe Proposal Submission ─────────────────────────────────────────────────

/**
 * Propose a Safe multisig transaction to the Safe Transaction Service.
 * The AI (HIEF Solver) acts as the proposer and signs the safeTxHash.
 * Co-signers can then approve via the Safe UI.
 */
export async function proposeSafeMultisig(params: {
  safeAddress: string;
  chainId: number;
  rpcUrl: string;
  proposerPrivateKey: string;
  /** Settlement calldata: to, value, data */
  to: string;
  value: string;
  data: string;
  /** 0 = CALL (default), 1 = DELEGATECALL (needed for MultiSend) */
  operation?: 0 | 1;
  intentId: string;
}): Promise<SafeProposalResult> {
  const { safeAddress, chainId, rpcUrl, proposerPrivateKey, to, value, data, intentId } = params;
  const operation: 0 | 1 = params.operation ?? 0;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const proposerWallet = new ethers.Wallet(proposerPrivateKey, provider);
  const safeContract = new ethers.Contract(safeAddress, SAFE_ABI, provider);

  // Fetch current nonce from Safe contract
  const nonce = Number(await safeContract.nonce());

  // Build Safe transaction
  const safeTx = buildSafeTxData(to, value, data, nonce, operation);

  // Compute EIP-712 hash
  const safeTxHash = computeSafeTxHash(safeTx, safeAddress, chainId);

  // Sign using EIP-712 signTypedData (v=27/28) — required by this Safe contract.
  // Note: signMessage (eth_sign, v=31/32) is rejected by the Tenderly fork Safe.
  const typedDataForSigning = buildSafeTxTypedData(safeTx, safeAddress, chainId);
  const { domain: sigDomain, types: sigTypes, message: sigMessage } = typedDataForSigning;
  const typesWithoutDomain: Record<string, { name: string; type: string }[]> = { ...sigTypes };
  delete typesWithoutDomain.EIP712Domain;
  const signature = await proposerWallet.signTypedData(sigDomain, typesWithoutDomain, sigMessage);

  // Determine Safe Transaction Service URL
  const serviceUrl = SAFE_TX_SERVICE[chainId] || SAFE_TX_SERVICE[84532];

  // Submit to Safe Transaction Service
  const payload = {
    to: safeTx.to,
    value: safeTx.value,
    data: safeTx.data,
    operation: safeTx.operation,
    safeTxGas: safeTx.safeTxGas,
    baseGas: safeTx.baseGas,
    gasPrice: safeTx.gasPrice,
    gasToken: safeTx.gasToken,
    refundReceiver: safeTx.refundReceiver,
    nonce: safeTx.nonce,
    contractTransactionHash: safeTxHash,
    sender: proposerWallet.address,
    signature,
    origin: `HIEF Intent ${intentId.slice(0, 16)}`,
  };

  try {
    const resp = await fetch(`${serviceUrl}/api/v1/safes/${safeAddress}/multisig-transactions/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.warn(`[SafeMultisig] Safe TX Service returned ${resp.status}: ${errText}`);
      // Don't throw — we still have the safeTxHash for the UI
    } else {
      console.log(`[SafeMultisig] ✅ Proposal submitted to Safe TX Service | safeTxHash: ${safeTxHash.slice(0, 16)}...`);
    }
  } catch (err: any) {
    console.warn(`[SafeMultisig] Could not reach Safe TX Service: ${err.message}. safeTxHash still valid for manual signing.`);
  }

  // Build the Safe UI signing URL
  const networkSlug = chainId === 8453 ? 'base' : chainId === 84532 ? 'basesep' : 'basesep';
  const signingUrl = `${SAFE_UI_URL}/transactions/tx?safe=${networkSlug}:${safeAddress}&id=multisig_${safeAddress}_${safeTxHash}`;

  return {
    safeTxHash,
    safeAddress,
    threshold: 0, // Will be filled by caller
    nonce,
    proposedAt: Math.floor(Date.now() / 1000),
    safeServiceUrl: serviceUrl,
    signingUrl,
  };
}

// ─── Execute Safe TX with collected signatures ────────────────────────────────

export interface SafeTxData {
  to: string;
  value: string;
  data: string;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: number;
}

/**
 * Execute a Safe transaction on-chain using two collected signatures.
 * Safe requires signatures to be sorted by signer address (ascending).
 *
 * @param safeAddress  - The Gnosis Safe contract address
 * @param safeTx       - The Safe transaction parameters
 * @param sig1         - Signature from signer1 (raw 65-byte hex)
 * @param signer1      - Address of signer1
 * @param sig2         - Signature from signer2 (raw 65-byte hex)
 * @param signer2      - Address of signer2
 * @param executorKey  - Private key of the executor (pays gas, can be any owner)
 * @param rpcUrl       - RPC endpoint
 */
export async function executeWithSignatures(params: {
  safeAddress: string;
  safeTx: SafeTxData;
  sig1: string;
  signer1: string;
  sig2: string;
  signer2: string;
  executorKey: string;
  rpcUrl: string;
  /** Pre-computed gas limit (e.g. from simulation). Skips on-chain estimation when provided. */
  simulatedGasUsed?: number;
}): Promise<{ txHash: string; blockNumber: number }> {
  const { safeAddress, safeTx, sig1, signer1, sig2, signer2, executorKey, rpcUrl, simulatedGasUsed } = params;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const executor = new ethers.Wallet(executorKey, provider);
  const safeContract = new ethers.Contract(safeAddress, SAFE_ABI, executor);

  // Safe requires signatures sorted by signer address (ascending, case-insensitive)
  let packedSigs: string;
  if (signer1.toLowerCase() < signer2.toLowerCase()) {
    // sig1 first, then sig2
    packedSigs = sig1.startsWith('0x') ? sig1 : '0x' + sig1;
    const s2 = sig2.startsWith('0x') ? sig2.slice(2) : sig2;
    packedSigs += s2;
  } else {
    // sig2 first, then sig1
    packedSigs = sig2.startsWith('0x') ? sig2 : '0x' + sig2;
    const s1 = sig1.startsWith('0x') ? sig1.slice(2) : sig1;
    packedSigs += s1;
  }

  console.log(`[SafeMultisig] Executing Safe TX | to: ${safeTx.to} | nonce: ${safeTx.nonce}`);
  console.log(`[SafeMultisig] Signers: ${signer1.slice(0,10)}... & ${signer2.slice(0,10)}...`);

  const execArgs = [
    safeTx.to,
    BigInt(safeTx.value),
    safeTx.data,
    safeTx.operation,
    BigInt(safeTx.safeTxGas),
    BigInt(safeTx.baseGas),
    BigInt(safeTx.gasPrice),
    safeTx.gasToken,
    safeTx.refundReceiver,
    packedSigs,
  ] as const;

  let gasLimit: bigint;
  if (simulatedGasUsed && simulatedGasUsed > 0) {
    // Use simulation gas + Safe execution overhead (50k) + 30% buffer
    gasLimit = BigInt(Math.ceil((simulatedGasUsed + 50_000) * 1.3));
    console.log(`[SafeMultisig] Using simulation gas: ${simulatedGasUsed} + overhead → gasLimit: ${gasLimit}`);
  } else {
    try {
      const estimated = await safeContract.execTransaction.estimateGas(...execArgs);
      gasLimit = estimated * 125n / 100n; // 25% buffer
      console.log(`[SafeMultisig] Gas estimated: ${estimated} → using ${gasLimit}`);
    } catch (estErr: any) {
      // estimateGas can fail for Safe txs (e.g. signature validation in dry-run context).
      // Fall back to a generous limit — the simulation already verified this tx succeeds.
      gasLimit = 3_000_000n;
      const reason = estErr?.info?.error?.message ?? estErr?.message ?? String(estErr);
      console.warn(`[SafeMultisig] estimateGas failed (${reason.slice(0, 120)}), using fallback gasLimit=${gasLimit}`);
    }
  }

  const tx = await safeContract.execTransaction(...execArgs, { gasLimit });

  const receipt = await tx.wait();
  const txHash = receipt?.hash || tx.hash;
  const blockNumber = receipt?.blockNumber || 0;

  console.log(`[SafeMultisig] ✅ execTransaction confirmed | txHash: ${txHash} | block: ${blockNumber}`);
  return { txHash, blockNumber };
}

/**
 * Build the EIP-712 typed data for a Safe transaction.
 * Used by the frontend to call eth_signTypedData_v4 via MetaMask.
 */
export function buildSafeTxTypedData(safeTx: SafeTxData, safeAddress: string, chainId: number) {
  return {
    types: {
      EIP712Domain: [
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'SafeTx',
    domain: {
      chainId: chainId.toString(),
      verifyingContract: safeAddress,
    },
    message: {
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data,
      operation: safeTx.operation,
      safeTxGas: safeTx.safeTxGas,
      baseGas: safeTx.baseGas,
      gasPrice: safeTx.gasPrice,
      gasToken: safeTx.gasToken,
      refundReceiver: safeTx.refundReceiver,
      nonce: safeTx.nonce,
    },
  };
}
