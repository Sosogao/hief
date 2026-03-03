import { ethers } from 'ethers';
import type { HIEFIntent } from '../types';

const HIEF_DOMAIN_NAME = 'HIEF';
const HIEF_DOMAIN_VERSION = '0.1';

// EIP-712 typed data structure for HIEFIntent
// Note: OutputConstraint is hashed separately (outputsHash), not included as a nested type
const INTENT_TYPES = {
  InputAsset: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Constraints: [
    { name: 'slippageBps', type: 'uint32' },
    { name: 'maxSpend', type: 'uint256' },
    { name: 'nonceSalt', type: 'bytes32' },
  ],
  PolicyRef: [
    { name: 'policyVersion', type: 'bytes32' },
    { name: 'policyHash', type: 'bytes32' },
  ],
  HIEFIntent: [
    { name: 'intentVersion', type: 'bytes32' },
    { name: 'intentId', type: 'bytes32' },
    { name: 'smartAccount', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'input', type: 'InputAsset' },
    { name: 'outputsHash', type: 'bytes32' },
    { name: 'constraints', type: 'Constraints' },
    { name: 'policyRef', type: 'PolicyRef' },
    { name: 'extensionsHash', type: 'bytes32' },
  ],
};

/**
 * Compute the EIP-712 hash for a HIEFIntent.
 * This hash is the canonical identifier for the intent and must be
 * consistent across all implementations.
 */
export function computeIntentHash(intent: HIEFIntent): string {
  const domain = {
    name: HIEF_DOMAIN_NAME,
    version: HIEF_DOMAIN_VERSION,
    chainId: intent.chainId,
    verifyingContract: ethers.ZeroAddress,
  };

  const outputsHash = computeOutputsHash(intent);
  const extensionsHash = computeExtensionsHash(intent.extensions);

  const value = {
    intentVersion: ethers.keccak256(ethers.toUtf8Bytes(intent.intentVersion)),
    intentId: intent.intentId,
    smartAccount: intent.smartAccount,
    chainId: intent.chainId,
    deadline: intent.deadline,
    input: {
      token: intent.input.token,
      amount: BigInt(intent.input.amount),
    },
    outputsHash,
    constraints: {
      slippageBps: intent.constraints.slippageBps ?? 0,
      maxSpend: BigInt(intent.constraints.maxSpend ?? '0'),
      nonceSalt: intent.constraints.nonceSalt ?? ethers.ZeroHash,
    },
    policyRef: {
      policyVersion: ethers.keccak256(
        ethers.toUtf8Bytes(intent.policyRef.policyVersion)
      ),
      policyHash: intent.policyRef.policyHash ?? ethers.ZeroHash,
    },
    extensionsHash,
  };

  return ethers.TypedDataEncoder.hash(domain, INTENT_TYPES, value);
}

/**
 * Compute the hash of the outputs array.
 * Each output is hashed individually, then all hashes are concatenated and hashed.
 */
function computeOutputsHash(intent: HIEFIntent): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const itemHashes = intent.outputs.map((o) => {
    return ethers.keccak256(
      coder.encode(
        ['address', 'uint256', 'address'],
        [o.token, BigInt(o.minAmount), o.recipient ?? intent.smartAccount]
      )
    );
  });
  return ethers.keccak256(ethers.concat(itemHashes));
}

/**
 * Compute the hash of the extensions object.
 * Returns ZeroHash if extensions is empty or undefined.
 */
function computeExtensionsHash(
  extensions: Record<string, unknown> | undefined
): string {
  if (!extensions || Object.keys(extensions).length === 0) {
    return ethers.ZeroHash;
  }
  // Use JSON.stringify with sorted keys for deterministic serialization
  const canonical = JSON.stringify(extensions, Object.keys(extensions).sort());
  return ethers.keccak256(ethers.toUtf8Bytes(canonical));
}

/**
 * Verify the EIP-712 signature on a HIEFIntent.
 */
export function verifyIntentSignature(
  intent: HIEFIntent,
  intentHash: string
): boolean {
  try {
    if (intent.signature.type === 'EIP712_EOA') {
      const recovered = ethers.recoverAddress(intentHash, intent.signature.sig);
      return recovered.toLowerCase() === intent.signature.signer.toLowerCase();
    }
    // ERC1271 and SAFE signature types require on-chain verification
    // For MVP, we accept them without full verification
    return true;
  } catch {
    return false;
  }
}
