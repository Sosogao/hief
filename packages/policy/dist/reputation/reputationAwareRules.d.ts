/**
 * HIEF Reputation-Aware Rules
 *
 * Wraps the static rule engine with dynamic per-user thresholds
 * derived from the user's reputation tier.
 *
 * Key overrides:
 *  - R4 (fee cap): uses tier-specific maxFeeBps
 *  - R5 (slippage cap): uses tier-specific maxSlippageBps
 *  - R_DAILY_LIMIT (new): checks daily volume against tier limit
 *
 * All other rules (R1, R2, R6, R7, R10, R11, R12) remain unchanged —
 * security rules are never relaxed by reputation.
 */
import type { HIEFIntent, HIEFSolution, PolicyFinding } from '@hief/common';
import { RuleResult } from '../rules/staticRules';
import { DynamicPolicyParams } from './reputationPolicyAdapter';
export interface ReputationAwareRuleResult {
    results: RuleResult[];
    reputationFindings: PolicyFinding[];
    hasCriticalFailure: boolean;
    hasHighFailure: boolean;
    appliedParams: DynamicPolicyParams;
}
/**
 * Run static rules with reputation-adjusted thresholds.
 *
 * Security rules (R1, R2, R6, R7, R10, R11, R12) are NEVER relaxed.
 * Only economic parameters (slippage, fee) are adjusted per tier.
 */
export declare function runReputationAwareRules(intent: HIEFIntent, solution: HIEFSolution, params: DynamicPolicyParams): ReputationAwareRuleResult;
//# sourceMappingURL=reputationAwareRules.d.ts.map