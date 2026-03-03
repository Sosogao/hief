import type { HIEFSolution } from '../types';
/**
 * Compute the hash of the executionPlan.calls array.
 * Each call is hashed individually, then all hashes are concatenated and hashed.
 */
export declare function computeCallsHash(solution: HIEFSolution): string;
/**
 * Compute the canonical hash for a HIEFSolution.
 * Covers: solutionId, intentHash, solverId, callsHash, quote fields.
 */
export declare function computeSolutionHash(solution: HIEFSolution): string;
/**
 * Compute the planHash — the tamper-evident binding between
 * a validated Solution and the Safe transaction that will execute it.
 *
 * planHash = keccak256(callsHash || intentHash || solutionId)
 *
 * This hash must be verified by the Safe Adapter before creating a proposal.
 */
export declare function computePlanHash(solution: HIEFSolution, intentHash: string): string;
/**
 * Verify the EIP-712 signature on a HIEFSolution.
 */
export declare function verifySolutionSignature(solution: HIEFSolution, solutionHash: string): boolean;
//# sourceMappingURL=solutionHash.d.ts.map