"use strict";
/**
 * HIEF Reputation-Aware Agent Adapter
 *
 * Fetches a user's reputation and injects tier-specific context into
 * the AI conversation engine:
 *
 *  - UNKNOWN / NEWCOMER: verbose risk warnings, conservative suggestions,
 *    explicit confirmation of limits
 *  - TRUSTED: standard flow, brief risk notes
 *  - ELITE: streamlined flow, minimal friction, advanced options surfaced
 *
 * The adapter also enriches the confirmation message shown to the user
 * with their tier badge and any active warnings.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReputationAgentAdapter = void 0;
exports.getReputationAgentAdapter = getReputationAgentAdapter;
exports.resetReputationAgentAdapter = resetReputationAgentAdapter;
const axios_1 = __importDefault(require("axios"));
// ── Tier metadata ─────────────────────────────────────────────────────────────
const TIER_META = {
    UNKNOWN: {
        badge: '🆕 Unknown',
        description: 'No on-chain history found. Strictest limits apply for your protection.',
        maxSlippageBps: 50,
        maxFeeBps: 100,
        dailyLimitUsd: 500,
        requireSimulation: true,
    },
    NEWCOMER: {
        badge: '🌱 Newcomer',
        description: 'You\'re building your on-chain reputation. Limits will expand as you transact.',
        maxSlippageBps: 100,
        maxFeeBps: 200,
        dailyLimitUsd: 2_000,
        requireSimulation: true,
    },
    TRUSTED: {
        badge: '✅ Trusted',
        description: 'You have a solid transaction history. Standard limits apply.',
        maxSlippageBps: 200,
        maxFeeBps: 300,
        dailyLimitUsd: 10_000,
        requireSimulation: false,
    },
    ELITE: {
        badge: '⭐ Elite',
        description: 'Top-tier reputation. Highest limits and streamlined execution.',
        maxSlippageBps: 500,
        maxFeeBps: 500,
        dailyLimitUsd: 100_000,
        requireSimulation: false,
    },
};
// ── Adapter ───────────────────────────────────────────────────────────────────
class ReputationAgentAdapter {
    baseUrl;
    timeoutMs;
    constructor(baseUrl = process.env.REPUTATION_API_URL ?? 'http://localhost:3002', timeoutMs = 3_000) {
        this.baseUrl = baseUrl;
        this.timeoutMs = timeoutMs;
    }
    /**
     * Fetch reputation context for a user address.
     * Falls back to UNKNOWN tier on any error.
     */
    async getUserContext(address) {
        try {
            const { data } = await axios_1.default.get(`${this.baseUrl}/v1/reputation/${address}`, { timeout: this.timeoutMs });
            const tier = data.tier ?? 'UNKNOWN';
            const meta = TIER_META[tier];
            const riskWarnings = this._buildRiskWarnings(tier, data);
            return {
                tier,
                score: data.compositeScore ?? 0,
                behaviorTags: data.behaviorTags ?? [],
                riskWarnings,
                tierBadge: meta.badge,
                tierDescription: meta.description,
                maxSlippageBps: meta.maxSlippageBps,
                maxFeeBps: meta.maxFeeBps,
                dailyLimitUsd: meta.dailyLimitUsd,
                requireSimulation: meta.requireSimulation,
            };
        }
        catch {
            return this._unknownContext();
        }
    }
    /**
     * Build a tier-aware system prompt suffix to inject into the AI conversation.
     * This shapes how the AI presents risk information to the user.
     */
    buildSystemPromptSuffix(ctx) {
        const lines = [
            `\n## User Reputation Context`,
            `- Tier: ${ctx.tierBadge} (score: ${ctx.score})`,
            `- ${ctx.tierDescription}`,
            `- Max slippage: ${ctx.maxSlippageBps / 100}% | Max fee: ${ctx.maxFeeBps / 100}% | Daily limit: $${ctx.dailyLimitUsd.toLocaleString()}`,
        ];
        if (ctx.behaviorTags.length > 0) {
            lines.push(`- Behavior profile: ${ctx.behaviorTags.join(', ')}`);
        }
        if (ctx.tier === 'UNKNOWN' || ctx.tier === 'NEWCOMER') {
            lines.push(`\n## Conversation Style for this User`, `- Be extra cautious and explain risks clearly`, `- Always mention the daily limit ($${ctx.dailyLimitUsd.toLocaleString()}) when relevant`, `- Suggest conservative slippage settings (0.1% - 0.3%)`, `- Explicitly confirm the transaction before submitting`);
        }
        else if (ctx.tier === 'TRUSTED') {
            lines.push(`\n## Conversation Style for this User`, `- Standard flow, brief risk notes only`, `- Suggest standard slippage (0.3% - 0.5%)`);
        }
        else if (ctx.tier === 'ELITE') {
            lines.push(`\n## Conversation Style for this User`, `- Streamlined flow, minimal friction`, `- Surface advanced options (custom slippage, deadline, partial fills)`, `- User is experienced — skip basic explanations`);
        }
        if (ctx.riskWarnings.length > 0) {
            lines.push(`\n## Active Risk Warnings (mention these)`);
            ctx.riskWarnings.forEach((w) => lines.push(`- ⚠️ ${w}`));
        }
        return lines.join('\n');
    }
    /**
     * Build a tier badge line for the confirmation message shown to the user.
     */
    buildConfirmationHeader(ctx) {
        const lines = [`${ctx.tierBadge} | Score: ${ctx.score}`];
        if (ctx.riskWarnings.length > 0) {
            lines.push(...ctx.riskWarnings.map((w) => `⚠️ ${w}`));
        }
        return lines.join('\n');
    }
    // ── Private helpers ─────────────────────────────────────────────────────────
    _buildRiskWarnings(tier, data) {
        const warnings = [];
        if (tier === 'UNKNOWN') {
            warnings.push('No on-chain history detected. Strictest policy limits applied.');
        }
        const daysSinceActive = data?.metrics?.daysSinceLastActive;
        if (typeof daysSinceActive === 'number' && daysSinceActive > 90) {
            warnings.push(`Account inactive for ${daysSinceActive} days. Reputation score may be decayed.`);
        }
        const successRate = data?.metrics?.successRate;
        if (typeof successRate === 'number' && successRate < 0.8) {
            warnings.push(`Low historical success rate (${(successRate * 100).toFixed(1)}%). Review transaction parameters carefully.`);
        }
        return warnings;
    }
    _unknownContext() {
        const meta = TIER_META['UNKNOWN'];
        return {
            tier: 'UNKNOWN',
            score: 0,
            behaviorTags: [],
            riskWarnings: ['No on-chain history detected. Strictest policy limits applied.'],
            tierBadge: meta.badge,
            tierDescription: meta.description,
            maxSlippageBps: meta.maxSlippageBps,
            maxFeeBps: meta.maxFeeBps,
            dailyLimitUsd: meta.dailyLimitUsd,
            requireSimulation: meta.requireSimulation,
        };
    }
}
exports.ReputationAgentAdapter = ReputationAgentAdapter;
// ── Singleton ─────────────────────────────────────────────────────────────────
let _adapter = null;
function getReputationAgentAdapter() {
    if (!_adapter)
        _adapter = new ReputationAgentAdapter();
    return _adapter;
}
function resetReputationAgentAdapter() {
    _adapter = null;
}
//# sourceMappingURL=reputationAgentAdapter.js.map