import type { HIEFIntent, HIEFSolution, HIEFPolicyResult } from '@hief/common';
export interface SafeTransaction {
    to: string;
    value: string;
    data: string;
    operation: 0 | 1;
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
 * Build and propose a Safe transaction from a HIEF Solution.
 */
export declare function buildSafeTransaction(intent: HIEFIntent, solution: HIEFSolution, policyResult: HIEFPolicyResult, safeAddress: string, chainId: number): Promise<SafeProposalResult>;
/**
 * Submit a Safe transaction proposal to the Safe Transaction Service.
 */
export declare function proposeSafeTransaction(safeAddress: string, chainId: number, safeTx: SafeTransaction, safeTxHash: string, senderAddress: string, senderSignature: string): Promise<boolean>;
//# sourceMappingURL=safeAdapter.d.ts.map