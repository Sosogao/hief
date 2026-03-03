"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeCallsHash = computeCallsHash;
exports.computeSolutionHash = computeSolutionHash;
exports.computePlanHash = computePlanHash;
exports.verifySolutionSignature = verifySolutionSignature;
const ethers_1 = require("ethers");
/**
 * Compute the hash of the executionPlan.calls array.
 * Each call is hashed individually, then all hashes are concatenated and hashed.
 */
function computeCallsHash(solution) {
    const coder = ethers_1.ethers.AbiCoder.defaultAbiCoder();
    const callHashes = solution.executionPlan.calls.map((c) => {
        return ethers_1.ethers.keccak256(coder.encode(['address', 'uint256', 'bytes'], [c.to, BigInt(c.value), c.data]));
    });
    return ethers_1.ethers.keccak256(ethers_1.ethers.concat(callHashes));
}
/**
 * Compute the canonical hash for a HIEFSolution.
 * Covers: solutionId, intentHash, solverId, callsHash, quote fields.
 */
function computeSolutionHash(solution) {
    const coder = ethers_1.ethers.AbiCoder.defaultAbiCoder();
    const callsHash = computeCallsHash(solution);
    return ethers_1.ethers.keccak256(coder.encode([
        'bytes32', // solutionId
        'bytes32', // intentHash
        'address', // solverId
        'bytes32', // callsHash
        'uint256', // expectedOut
        'uint256', // fee
        'uint256', // validUntil
    ], [
        solution.solutionId,
        solution.intentHash,
        solution.solverId,
        callsHash,
        BigInt(solution.quote.expectedOut),
        BigInt(solution.quote.fee),
        solution.quote.validUntil,
    ]));
}
/**
 * Compute the planHash — the tamper-evident binding between
 * a validated Solution and the Safe transaction that will execute it.
 *
 * planHash = keccak256(callsHash || intentHash || solutionId)
 *
 * This hash must be verified by the Safe Adapter before creating a proposal.
 */
function computePlanHash(solution, intentHash) {
    const coder = ethers_1.ethers.AbiCoder.defaultAbiCoder();
    const callsHash = computeCallsHash(solution);
    return ethers_1.ethers.keccak256(coder.encode(['bytes32', 'bytes32', 'bytes32'], [callsHash, intentHash, solution.solutionId]));
}
/**
 * Verify the EIP-712 signature on a HIEFSolution.
 */
function verifySolutionSignature(solution, solutionHash) {
    try {
        if (solution.signature.type === 'EIP712_EOA') {
            const recovered = ethers_1.ethers.recoverAddress(solutionHash, solution.signature.sig);
            return recovered.toLowerCase() === solution.solverId.toLowerCase();
        }
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=solutionHash.js.map