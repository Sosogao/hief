import { ethers } from 'ethers';
import type { HIEFSolution } from '../types';

/**
 * Compute the hash of the executionPlan.calls array.
 * Each call is hashed individually, then all hashes are concatenated and hashed.
 */
export function computeCallsHash(solution: HIEFSolution): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const callHashes = solution.executionPlan.calls.map((c) => {
    return ethers.keccak256(
      coder.encode(
        ['address', 'uint256', 'bytes'],
        [c.to, BigInt(c.value), c.data]
      )
    );
  });
  return ethers.keccak256(ethers.concat(callHashes));
}

/**
 * Compute the canonical hash for a HIEFSolution.
 * Covers: solutionId, intentHash, solverId, callsHash, quote fields.
 */
export function computeSolutionHash(solution: HIEFSolution): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const callsHash = computeCallsHash(solution);

  return ethers.keccak256(
    coder.encode(
      [
        'bytes32', // solutionId
        'bytes32', // intentHash
        'address', // solverId
        'bytes32', // callsHash
        'uint256', // expectedOut
        'uint256', // fee
        'uint256', // validUntil
      ],
      [
        solution.solutionId,
        solution.intentHash,
        solution.solverId,
        callsHash,
        BigInt(solution.quote.expectedOut),
        BigInt(solution.quote.fee),
        solution.quote.validUntil,
      ]
    )
  );
}

/**
 * Compute the planHash — the tamper-evident binding between
 * a validated Solution and the Safe transaction that will execute it.
 *
 * planHash = keccak256(callsHash || intentHash || solutionId)
 *
 * This hash must be verified by the Safe Adapter before creating a proposal.
 */
export function computePlanHash(
  solution: HIEFSolution,
  intentHash: string
): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const callsHash = computeCallsHash(solution);

  return ethers.keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'bytes32'],
      [callsHash, intentHash, solution.solutionId]
    )
  );
}

/**
 * Verify the EIP-712 signature on a HIEFSolution.
 */
export function verifySolutionSignature(
  solution: HIEFSolution,
  solutionHash: string
): boolean {
  try {
    if (solution.signature.type === 'EIP712_EOA') {
      const recovered = ethers.recoverAddress(
        solutionHash,
        solution.signature.sig
      );
      return recovered.toLowerCase() === solution.solverId.toLowerCase();
    }
    return true;
  } catch {
    return false;
  }
}
