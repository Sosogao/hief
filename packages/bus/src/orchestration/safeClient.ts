import axios from 'axios';
import { ethers } from 'ethers';
import type { HIEFIntent, HIEFSolution, HIEFPolicyResult } from '@hief/common';
import { CONTRACTS } from '@hief/common';

const SAFE_TX_SERVICE_URLS: Record<number, string> = {
  1: 'https://safe-transaction-mainnet.safe.global',
  8453: 'https://safe-transaction-base.safe.global',
  84532: 'https://safe-transaction-base-sepolia.safe.global',
};

/**
 * Build a Safe transaction from an ExecutionPlan.
 * Uses MultiSend for multiple calls, direct call for single call.
 */
export function buildSafeTx(
  solution: HIEFSolution,
  safeAddress: string,
  planHash: string
): {
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
} {
  const calls = solution.executionPlan.calls;

  let to: string;
  let value: string;
  let data: string;
  let operation: number;

  if (calls.length === 1) {
    // Single call - direct execution
    to = calls[0].to;
    value = calls[0].value;
    data = calls[0].data;
    operation = 0; // CALL
  } else {
    // Multiple calls - use MultiSend
    const multiSendData = encodeMultiSend(calls);
    to = CONTRACTS.MULTISEND;
    value = '0';
    data = multiSendData;
    operation = 0; // CALL (MultiSend itself is a CALL)
  }

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
    nonce: 0, // Will be fetched from Safe
  };
}

/**
 * Encode multiple calls into MultiSend format.
 */
function encodeMultiSend(
  calls: Array<{ to: string; value: string; data: string; operation: string }>
): string {
  const encoded = calls.map((call) => {
    const dataBytes = ethers.getBytes(call.data);
    return ethers.concat([
      ethers.toBeHex(0, 1),                              // operation (1 byte)
      ethers.zeroPadValue(call.to, 20),                  // to (20 bytes)
      ethers.toBeHex(BigInt(call.value), 32),            // value (32 bytes)
      ethers.toBeHex(dataBytes.length, 32),              // data length (32 bytes)
      dataBytes,                                          // data (variable)
    ]);
  });

  const multiSendCalldata = ethers.concat(encoded);
  const iface = new ethers.Interface([
    'function multiSend(bytes transactions)',
  ]);
  return iface.encodeFunctionData('multiSend', [multiSendCalldata]);
}

/**
 * Submit a Safe transaction proposal to the Safe Transaction Service.
 * Returns the safeTxHash if successful.
 */
export async function createSafeProposal(
  intent: HIEFIntent,
  solution: HIEFSolution,
  policyResult: HIEFPolicyResult,
  planHash: string,
  safeAddress: string,
  chainId: number
): Promise<string | undefined> {
  const serviceUrl = SAFE_TX_SERVICE_URLS[chainId];
  if (!serviceUrl) {
    console.warn(`[SAFE] No Safe TX service URL for chainId ${chainId}`);
    return undefined;
  }

  const safeTx = buildSafeTx(solution, safeAddress, planHash);

  // Compute safeTxHash (EIP-712)
  const safeTxHash = computeSafeTxHash(safeTx, safeAddress, chainId);

  const description = [
    `HIEF Intent: ${intent.intentId}`,
    `Solution: ${solution.solutionId}`,
    `Policy: ${policyResult.status}`,
    `planHash: ${planHash}`,
    ...policyResult.summary,
  ].join('\n');

  try {
    await axios.post(
      `${serviceUrl}/api/v1/safes/${safeAddress}/multisig-transactions/`,
      {
        ...safeTx,
        contractTransactionHash: safeTxHash,
        sender: safeAddress,
        signature: '0x', // Will be signed by user in UI
        origin: JSON.stringify({
          url: 'https://hief.xyz',
          name: 'HIEF',
          description,
        }),
      },
      { timeout: 10000 }
    );
    return safeTxHash;
  } catch (err: any) {
    console.error('[SAFE] Failed to submit proposal:', err.response?.data || err.message);
    return undefined;
  }
}

/**
 * Compute the Safe transaction hash (EIP-712).
 */
function computeSafeTxHash(
  safeTx: ReturnType<typeof buildSafeTx>,
  safeAddress: string,
  chainId: number
): string {
  const SAFE_TX_TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes(
      'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)'
    )
  );

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const safeTxHash = ethers.keccak256(
    coder.encode(
      ['bytes32', 'address', 'uint256', 'bytes32', 'uint8', 'uint256', 'uint256', 'uint256', 'address', 'address', 'uint256'],
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
      ['bytes32', 'uint256', 'address'],
      [DOMAIN_SEPARATOR_TYPEHASH, chainId, safeAddress]
    )
  );

  return ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes('\x19\x01'),
      domainSeparator,
      safeTxHash,
    ])
  );
}
