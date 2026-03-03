import type { HIEFIntent, HIEFSolution, HIEFPolicyResult } from '@hief/common';
/**
 * Call the Policy Engine to validate a Solution against an Intent.
 * This is the critical security checkpoint before creating a Safe proposal.
 */
export declare function callPolicyEngine(intent: HIEFIntent, solution: HIEFSolution): Promise<HIEFPolicyResult>;
/**
 * Call the Policy Engine to pre-validate an Intent (lightweight check).
 */
export declare function callPolicyEngineForIntent(intent: HIEFIntent): Promise<HIEFPolicyResult>;
//# sourceMappingURL=policyClient.d.ts.map