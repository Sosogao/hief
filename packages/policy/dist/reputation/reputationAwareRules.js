"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.runReputationAwareRules = runReputationAwareRules;
const staticRules_1 = require("../rules/staticRules");
/**
 * Run static rules with reputation-adjusted thresholds.
 *
 * Security rules (R1, R2, R6, R7, R10, R11, R12) are NEVER relaxed.
 * Only economic parameters (slippage, fee) are adjusted per tier.
 */
function runReputationAwareRules(intent, solution, params) {
    const reputationFindings = [];
    // ── Run base static rules ────────────────────────────────────────────────
    const { results, hasCriticalFailure } = (0, staticRules_1.runStaticRules)(intent, solution);
    // ── Override R4 (fee cap) with tier-specific threshold ───────────────────
    const r4Index = results.findIndex((r) => r.ruleId === 'R4');
    if (r4Index !== -1) {
        const feeStr = solution.quote.fee ?? '0';
        const feeBps = parseInt(feeStr.replace('bps', '').trim(), 10) || 0;
        const tierMaxFee = params.maxFeeBps;
        const passed = feeBps <= tierMaxFee;
        results[r4Index] = {
            ruleId: 'R4',
            passed,
            severity: 'HIGH',
            finding: passed ? undefined : {
                ruleId: 'R4',
                severity: 'HIGH',
                message: `Fee ${feeBps}bps exceeds tier limit ${tierMaxFee}bps (${params.tier} tier)`,
                field: 'solution.quote.fee',
                actual: feeBps.toString(),
                expected: `<= ${tierMaxFee}`,
            },
        };
    }
    // ── Override R5 (slippage cap) with tier-specific threshold ─────────────
    const r5Index = results.findIndex((r) => r.ruleId === 'R5');
    if (r5Index !== -1) {
        const slippage = intent.constraints?.slippageBps ?? 0;
        const tierMaxSlippage = params.maxSlippageBps;
        const passed = slippage <= tierMaxSlippage;
        results[r5Index] = {
            ruleId: 'R5',
            passed,
            severity: 'HIGH',
            finding: passed ? undefined : {
                ruleId: 'R5',
                severity: 'HIGH',
                message: `Slippage ${slippage}bps exceeds tier limit ${tierMaxSlippage}bps (${params.tier} tier)`,
                field: 'intent.constraints.slippageBps',
                actual: slippage.toString(),
                expected: `<= ${tierMaxSlippage}`,
            },
        };
    }
    // ── R_DAILY_LIMIT: check daily volume against tier limit ─────────────────
    // Note: in production this would query the Intent Bus for daily volume.
    // Here we use uiHints.inputAmountUsd if provided, otherwise 0 (no limit check).
    const inputAmountUsd = parseFloat(intent.meta?.uiHints?.['inputAmountUsd'] ?? '0');
    if (inputAmountUsd > 0 && inputAmountUsd > params.dailyLimitUsd) {
        reputationFindings.push({
            ruleId: 'R_DAILY_LIMIT',
            severity: 'HIGH',
            message: `Transaction amount $${inputAmountUsd.toFixed(2)} exceeds daily limit $${params.dailyLimitUsd.toLocaleString()} for ${params.tier} tier`,
            evidence: {
                inputAmountUsd,
                dailyLimitUsd: params.dailyLimitUsd,
                tier: params.tier,
            },
        });
    }
    // ── Add risk warnings as LOW findings ────────────────────────────────────
    for (const warning of params.riskWarnings) {
        reputationFindings.push({
            ruleId: 'R_REP_WARN',
            severity: 'LOW',
            message: warning,
            evidence: { tier: params.tier, score: params.score },
        });
    }
    // ── Compute final failure flags ──────────────────────────────────────────
    const CRITICAL_RULES = new Set(['R1', 'R2', 'R6', 'R10', 'R11', 'R12']);
    const HIGH_RULES = new Set(['R3', 'R4', 'R5', 'R7', 'R_DAILY_LIMIT']);
    const allResults = [...results];
    const hasCritical = hasCriticalFailure;
    const hasHigh = allResults.some((r) => !r.passed && HIGH_RULES.has(r.ruleId)) ||
        reputationFindings.some((f) => f.severity === 'HIGH');
    return {
        results: allResults,
        reputationFindings,
        hasCriticalFailure: hasCritical,
        hasHighFailure: hasHigh,
        appliedParams: params,
    };
}
//# sourceMappingURL=reputationAwareRules.js.map