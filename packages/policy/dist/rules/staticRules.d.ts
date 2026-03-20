import type { HIEFIntent, HIEFSolution, HIEFSessionGrant, Severity } from '@hief/common';
export interface RuleResult {
    ruleId: string;
    passed: boolean;
    severity: Severity;
    finding?: RuleFinding;
}
interface RuleFinding {
    ruleId: string;
    severity: Severity;
    message: string;
    field?: string;
    actual?: string;
    expected?: string;
}
type RuleFn = (intent: HIEFIntent, solution: HIEFSolution) => RuleResult;
export declare function checkSessionKeyConstraints(intent: HIEFIntent, grant: HIEFSessionGrant, txUsdValue: number): RuleResult;
export declare const STATIC_RULES: RuleFn[];
export declare const CRITICAL_RULES: Set<string>;
export declare const HIGH_RULES: Set<string>;
export declare function runStaticRules(intent: HIEFIntent, solution: HIEFSolution): {
    results: RuleResult[];
    hasCriticalFailure: boolean;
    hasHighFailure: boolean;
};
export {};
//# sourceMappingURL=staticRules.d.ts.map