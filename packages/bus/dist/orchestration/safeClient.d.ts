import type { HIEFIntent, HIEFSolution, HIEFPolicyResult } from '@hief/common';
/**
 * Build a Safe transaction from an ExecutionPlan.
 * Uses MultiSend for multiple calls, direct call for single call.
 */
export declare function buildSafeTx(solution: HIEFSolution, safeAddress: string, planHash: string): {
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
};
/**
 * Submit a Safe transaction proposal to the Safe Transaction Service.
 * Returns the safeTxHash if successful.
 */
export declare function createSafeProposal(intent: HIEFIntent, solution: HIEFSolution, policyResult: HIEFPolicyResult, planHash: string, safeAddress: string, chainId: number): Promise<string | undefined>;
//# sourceMappingURL=safeClient.d.ts.map