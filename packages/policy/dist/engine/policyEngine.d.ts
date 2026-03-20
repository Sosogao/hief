import type { HIEFIntent, HIEFSolution, HIEFSessionGrant, HIEFPolicyResult } from '@hief/common';
export interface SessionContext {
    grant: HIEFSessionGrant;
    txUsdValue: number;
}
export declare function validateSolution(intent: HIEFIntent, solution: HIEFSolution, sessionContext?: SessionContext): Promise<HIEFPolicyResult>;
/**
 * Validate a solution with dynamic per-user policy parameters derived
 * from the user's reputation tier.
 *
 * Key differences from validateSolution():
 *  - R4 (fee cap) and R5 (slippage cap) thresholds are adjusted per tier
 *  - R_DAILY_LIMIT is enforced based on tier
 *  - Risk warnings are surfaced as LOW findings
 *  - reputationContext is attached to the result for transparency
 *
 * Security rules (R1, R2, R6, R7, R10, R11, R12) are NEVER relaxed.
 */
export declare function validateSolutionWithReputation(intent: HIEFIntent, solution: HIEFSolution, userAddress: string): Promise<HIEFPolicyResult>;
export declare function validateIntent(intent: HIEFIntent): Promise<HIEFPolicyResult>;
//# sourceMappingURL=policyEngine.d.ts.map