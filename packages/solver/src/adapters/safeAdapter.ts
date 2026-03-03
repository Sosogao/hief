import axios from 'axios';
import { ethers } from 'ethers';
import type { HIEFIntent, HIEFSolution, HIEFPolicyResult } from '@hief/common';
import { computePlanHash } from '@hief/common';

// Safe Transaction Service API
const SAFE_API_BASE: Record<number, string> = {
  1: 'https://safe-transaction-mainnet.safe.global',
  8453: 'https://safe-transaction-base.safe.global',
  84532: 'https://safe-transaction-base-sepolia.safe.global',
  31337: 'http://localhost:8545', // local dev
};

// Safe MultiSend contract
const MULTISEND_ADDRESS: Record<number, string> = {
  1: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
  8453: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
  84532: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
  31337: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
};

export interface SafeTransaction {
  to: string;
  value: string;
  data: string;
  operation: 0 | 1; // 0=CALL, 1=DELEGATECALL
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: number;
}

export interface SafeProposalResult {
  safeTxHash: string;
  safeAddress: string;
  planHash: string;
  humanSummary: string[];
  transaction: SafeTransaction;
}

/**
 * Encode multiple calls into a Safe MultiSend transaction.
 */
function encodeMultiSend(calls: HIEFSolution['executionPlan']['calls']): {
  to: string;
  data: string;
  operation: 0 | 1;
} {
  if (calls.length === 1) {
    const call = calls[0];
    return {
      to: call.to,
      data: call.data || '0x',
      operation: call.operation === 'DELEGATECALL' ? 1 : 0,
    };
  }

  // MultiSend encoding: each call is packed as:
  // operation (1 byte) + to (20 bytes) + value (32 bytes) + dataLength (32 bytes) + data
  let packed = '0x';
  for (const call of calls) {
    const op = call.operation === 'DELEGATECALL' ? '01' : '00';
    const to = call.to.toLowerCase().replace('0x', '').padStart(40, '0');
    const value = BigInt(call.value || '0').toString(16).padStart(64, '0');
    const data = call.data?.replace('0x', '') || '';
    const dataLen = (data.length / 2).toString(16).padStart(64, '0');
    packed += op + to + value + dataLen + data;
  }

  const multiSendIface = new ethers.Interface([
    'function multiSend(bytes memory transactions)',
  ]);
  const multiSendData = multiSendIface.encodeFunctionData('multiSend', [packed]);

  return {
    to: MULTISEND_ADDRESS[1], // Will be overridden per chain
    data: multiSendData,
    operation: 1, // DELEGATECALL for MultiSend
  };
}

/**
 * Get the current nonce for a Safe.
 */
async function getSafeNonce(safeAddress: string, chainId: number): Promise<number> {
  const apiBase = SAFE_API_BASE[chainId];
  if (!apiBase || chainId === 31337) return 0;

  try {
    const response = await axios.get(`${apiBase}/api/v1/safes/${safeAddress}/`, {
      timeout: 10000,
    });
    return response.data.nonce ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Build and propose a Safe transaction from a HIEF Solution.
 */
export async function buildSafeTransaction(
  intent: HIEFIntent,
  solution: HIEFSolution,
  policyResult: HIEFPolicyResult,
  safeAddress: string,
  chainId: number
): Promise<SafeProposalResult> {
  const planHash = computePlanHash(solution, policyResult.intentHash);
  const nonce = await getSafeNonce(safeAddress, chainId);

  const calls = solution.executionPlan.calls;
  const multiSendAddr = MULTISEND_ADDRESS[chainId] || MULTISEND_ADDRESS[1];

  let txTo: string;
  let txData: string;
  let txOperation: 0 | 1;

  if (calls.length === 1) {
    txTo = calls[0].to;
    txData = calls[0].data || '0x';
    txOperation = calls[0].operation === 'DELEGATECALL' ? 1 : 0;
  } else {
    // MultiSend
    let packed = '0x';
    for (const call of calls) {
      const op = call.operation === 'DELEGATECALL' ? '01' : '00';
      const to = call.to.toLowerCase().replace('0x', '').padStart(40, '0');
      const value = BigInt(call.value || '0').toString(16).padStart(64, '0');
      const data = call.data?.replace('0x', '') || '';
      const dataLen = (data.length / 2).toString(16).padStart(64, '0');
      packed += op + to + value + dataLen + data;
    }
    const multiSendIface = new ethers.Interface([
      'function multiSend(bytes memory transactions)',
    ]);
    txTo = multiSendAddr;
    txData = multiSendIface.encodeFunctionData('multiSend', [packed]);
    txOperation = 1;
  }

  const totalValue = calls.reduce((acc, c) => acc + BigInt(c.value || '0'), 0n);

  const safeTx: SafeTransaction = {
    to: txTo,
    value: totalValue.toString(),
    data: txData,
    operation: txOperation,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce,
  };

  // Compute Safe transaction hash (EIP-712)
  const SAFE_TX_TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes(
      'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)'
    )
  );

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedTx = abiCoder.encode(
    ['bytes32', 'address', 'uint256', 'bytes32', 'uint8', 'uint256', 'uint256', 'uint256', 'address', 'address', 'uint256'],
    [
      SAFE_TX_TYPEHASH,
      safeTx.to,
      safeTx.value,
      ethers.keccak256(safeTx.data),
      safeTx.operation,
      safeTx.safeTxGas,
      safeTx.baseGas,
      safeTx.gasPrice,
      safeTx.gasToken,
      safeTx.refundReceiver,
      safeTx.nonce,
    ]
  );
  const safeTxHash = ethers.keccak256(encodedTx);

  return {
    safeTxHash,
    safeAddress,
    planHash,
    humanSummary: policyResult.summary,
    transaction: safeTx,
  };
}

/**
 * Submit a Safe transaction proposal to the Safe Transaction Service.
 */
export async function proposeSafeTransaction(
  safeAddress: string,
  chainId: number,
  safeTx: SafeTransaction,
  safeTxHash: string,
  senderAddress: string,
  senderSignature: string
): Promise<boolean> {
  const apiBase = SAFE_API_BASE[chainId];
  if (!apiBase || chainId === 31337) {
    console.log('[SAFE] Local dev mode - skipping Safe Transaction Service submission');
    return true;
  }

  try {
    await axios.post(
      `${apiBase}/api/v1/safes/${safeAddress}/multisig-transactions/`,
      {
        ...safeTx,
        contractTransactionHash: safeTxHash,
        sender: senderAddress,
        signature: senderSignature,
        origin: 'HIEF Protocol v0.1',
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    return true;
  } catch (err: any) {
    console.error('[SAFE] Proposal submission failed:', err.response?.data || err.message);
    return false;
  }
}
