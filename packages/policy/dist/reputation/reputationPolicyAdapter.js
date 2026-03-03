"use strict";
/**
 * HIEF Reputation-Aware Policy Adapter
 *
 * Fetches a user's reputation snapshot from the Reputation API and
 * translates it into dynamic Policy parameters.
 *
 * Tier → Policy mapping:
 *
 * | Tier        | Score Range | Max Slippage | Max Fee | Simulation | Daily Limit |
 * |-------------|-------------|--------------|---------|------------|-------------|
 * | UNKNOWN     | 0-99        | 50 bps       | 100 bps | REQUIRED   | $500        |
 * | NEWCOMER    | 100-299     | 100 bps      | 200 bps | REQUIRED   | $2,000      |
 * | TRUSTED     | 300-599     | 200 bps      | 300 bps | OPTIONAL   | $10,000     |
 * | ELITE       | 600+        | 500 bps      | 500 bps | OPTIONAL   | $100,000    |
 *
 * Graceful degradation: if Reputation API is unreachable, falls back to UNKNOWN tier.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReputationPolicyAdapter = void 0;
exports.getReputationPolicyAdapter = getReputationPolicyAdapter;
exports.resetReputationPolicyAdapter = resetReputationPolicyAdapter;
const axios_1 = __importDefault(require("axios"));
// ── Tier Policy Table ─────────────────────────────────────────────────────────
const TIER_POLICY = {
    UNKNOWN: {
        maxSlippageBps: 50,
        maxFeeBps: 100,
        requireSimulation: true,
        dailyLimitUsd: 500,
    },
    NEWCOMER: {
        maxSlippageBps: 100,
        maxFeeBps: 200,
        requireSimulation: true,
        dailyLimitUsd: 2_000,
    },
    TRUSTED: {
        maxSlippageBps: 200,
        maxFeeBps: 300,
        requireSimulation: false,
        dailyLimitUsd: 10_000,
    },
    ELITE: {
        maxSlippageBps: 500,
        maxFeeBps: 500,
        requireSimulation: false,
        dailyLimitUsd: 100_000,
    },
};
// ── Reputation API Client ─────────────────────────────────────────────────────
class ReputationPolicyAdapter {
    baseUrl;
    timeoutMs;
    constructor(baseUrl = process.env.REPUTATION_API_URL ?? 'http://localhost:3002', timeoutMs = 3_000) {
        this.baseUrl = baseUrl;
        this.timeoutMs = timeoutMs;
    }
    /**
     * Fetch reputation snapshot and compute dynamic policy parameters.
     * Falls back to UNKNOWN tier on any error.
     */
    async getPolicyParams(address) {
        let snapshot = null;
        try {
            const { data } = await axios_1.default.get(`${this.baseUrl}/v1/reputation/${address}`, { timeout: this.timeoutMs });
            snapshot = data;
        }
        catch (err) {
            // Graceful degradation — treat as UNKNOWN
            console.warn(`[ReputationPolicyAdapter] Failed to fetch reputation for ${address}: ${err.message}. Using UNKNOWN tier.`);
        }
        return this._buildParams(snapshot, address);
    }
    /**
     * Build DynamicPolicyParams from a snapshot (or null for UNKNOWN).
     */
    _buildParams(snapshot, address) {
        const tier = snapshot?.tier ?? 'UNKNOWN';
        const score = snapshot?.compositeScore ?? 0;
        const behaviorTags = snapshot?.behaviorTags ?? [];
        const base = TIER_POLICY[tier];
        // Build contextual risk warnings based on behavior tags and metrics
        const riskWarnings = [];
        if (!snapshot) {
            riskWarnings.push('Address has no reputation history. Applying strictest policy limits.');
        }
        if (snapshot?.metrics.daysSinceLastActive !== undefined && snapshot.metrics.daysSinceLastActive > 90) {
            riskWarnings.push(`Address has been inactive for ${snapshot.metrics.daysSinceLastActive} days. Reputation score may be decayed.`);
        }
        if (snapshot?.metrics.successRate !== undefined && snapshot.metrics.successRate < 0.8) {
            riskWarnings.push(`Low historical success rate (${(snapshot.metrics.successRate * 100).toFixed(1)}%). Extra caution advised.`);
        }
        if (tier === 'UNKNOWN' || tier === 'NEWCOMER') {
            riskWarnings.push(`Daily transaction limit: $${base.dailyLimitUsd.toLocaleString()} USD.`);
        }
        return {
            tier,
            score,
            behaviorTags,
            riskWarnings,
            ...base,
        };
    }
}
exports.ReputationPolicyAdapter = ReputationPolicyAdapter;
// ── Singleton factory ─────────────────────────────────────────────────────────
let _adapter = null;
function getReputationPolicyAdapter() {
    if (!_adapter) {
        _adapter = new ReputationPolicyAdapter();
    }
    return _adapter;
}
function resetReputationPolicyAdapter() {
    _adapter = null;
}
//# sourceMappingURL=reputationPolicyAdapter.js.map