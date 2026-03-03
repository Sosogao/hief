"use strict";
/**
 * HIEF Reputation Scoring Engine
 *
 * Implements the four-dimensional weighted scoring algorithm from HIEF-REP-01 §4.
 *
 * Score Formula:
 *   S_score = (1 - failRate) × 1000
 *   V_score = log₁₀(totalVolumeUSD + 1) × 100   [capped at 1000]
 *   A_score = log(1 + alphaScoreSum) × 50         [capped at 1000]
 *   D_score = uniqueSkillsUsed × 20               [capped at 1000]
 *
 *   composite = w_s × S + w_v × V + w_a × A + w_d × D
 *   decay     = max(minDecay, 0.5^(daysSinceLastActivity / halfLifeDays))
 *   final     = composite × decay
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScoringEngine = void 0;
const crypto_1 = require("crypto");
const types_1 = require("../types");
class ScoringEngine {
    constructor(config = {}) {
        this.config = {
            ...types_1.DEFAULT_SCORING_CONFIG,
            weights: { ...types_1.DEFAULT_SCORING_CONFIG.weights, ...config.weights },
            tiers: { ...types_1.DEFAULT_SCORING_CONFIG.tiers, ...config.tiers },
            tags: { ...types_1.DEFAULT_SCORING_CONFIG.tags, ...config.tags },
            decayHalfLifeDays: config.decayHalfLifeDays ?? types_1.DEFAULT_SCORING_CONFIG.decayHalfLifeDays,
            minDecayFactor: config.minDecayFactor ?? types_1.DEFAULT_SCORING_CONFIG.minDecayFactor,
        };
    }
    // ─── Core Scoring ────────────────────────────────────────────────────────────
    /**
     * Compute all four dimension scores from address metrics.
     */
    computeScores(metrics, nowMs) {
        const now = nowMs ?? Date.now();
        // ── S_score: Success Rate ──────────────────────────────────────────────────
        const failRate = metrics.totalIntentsSubmitted > 0
            ? (metrics.totalIntentsFailed + metrics.totalIntentsExpired) / metrics.totalIntentsSubmitted
            : 0;
        const successScore = Math.round((1 - failRate) * 1000);
        // ── V_score: Volume (log-compressed to prevent whale dominance) ────────────
        const volumeScore = Math.min(1000, Math.round(Math.log10(metrics.totalVolumeUSD + 1) * 100));
        // ── A_score: Alpha Contribution ────────────────────────────────────────────
        const alphaScore = Math.min(1000, Math.round(Math.log(1 + metrics.alphaScoreSum) * 50));
        // ── D_score: Ecosystem Diversity ───────────────────────────────────────────
        const diversityScore = Math.min(1000, metrics.uniqueSkillsUsed * 20 +
            metrics.uniqueTokensTraded * 5 +
            metrics.uniqueChainsUsed * 30);
        // ── Composite (weighted sum) ───────────────────────────────────────────────
        const { weights } = this.config;
        const composite = Math.round(weights.success * successScore +
            weights.volume * volumeScore +
            weights.alpha * alphaScore +
            weights.diversity * diversityScore);
        // ── Time Decay ─────────────────────────────────────────────────────────────
        const daysSinceLastActivity = metrics.lastIntentAt > 0
            ? (now - metrics.lastIntentAt) / (1000 * 60 * 60 * 24)
            : 365; // No activity = 1 year decay
        const decayFactor = Math.max(this.config.minDecayFactor, Math.pow(0.5, daysSinceLastActivity / this.config.decayHalfLifeDays));
        // ── Final Score ────────────────────────────────────────────────────────────
        const final = Math.round(composite * decayFactor);
        return {
            successScore,
            volumeScore,
            alphaScore,
            diversityScore,
            composite,
            decayFactor: Math.round(decayFactor * 10000) / 10000,
            final,
        };
    }
    // ─── Behavior Tags ────────────────────────────────────────────────────────────
    /**
     * Derive behavior tags from metrics.
     */
    computeTags(metrics) {
        const tags = [];
        const t = this.config.tags;
        // HIGH_FREQUENCY_TRADER: > 50 intents/week average
        const weeksActive = Math.max(1, metrics.activeWeeks);
        if (metrics.totalIntentsSucceeded / weeksActive > t.highFrequencyWeeklyIntents) {
            tags.push('HIGH_FREQUENCY_TRADER');
        }
        // WHALE: single trade > $100k
        if (metrics.largestSingleTradeUSD >= t.whaleTradeUSD) {
            tags.push('WHALE');
        }
        // ALPHA_HUNTER: avg alpha score > 70
        if (metrics.alphaTradeCount > 0 &&
            metrics.alphaScoreSum / metrics.alphaTradeCount >= t.alphaHunterAvgScore) {
            tags.push('ALPHA_HUNTER');
        }
        // RELIABLE: success rate > 95%
        if (metrics.successRate >= t.reliableSuccessRate && metrics.totalIntentsSubmitted >= 10) {
            tags.push('RELIABLE');
        }
        // DIVERSIFIED: > 10 unique tokens
        if (metrics.uniqueTokensTraded >= t.diversifiedTokenCount) {
            tags.push('DIVERSIFIED');
        }
        // PROTOCOL_NATIVE: > 3 different Skills
        if (metrics.uniqueSkillsUsed >= t.protocolNativeSkillCount) {
            tags.push('PROTOCOL_NATIVE');
        }
        // MULTI_CHAIN: active on > 2 chains
        if (metrics.uniqueChainsUsed >= t.multiChainCount) {
            tags.push('MULTI_CHAIN');
        }
        // LOW_SLIPPAGE_OPTIMIZER: avg slippage < 20bps
        if (metrics.totalIntentsSucceeded >= 5 && metrics.avgSlippageBps < t.lowSlippageBps) {
            tags.push('LOW_SLIPPAGE_OPTIMIZER');
        }
        return tags;
    }
    // ─── Risk Tier ────────────────────────────────────────────────────────────────
    /**
     * Map final score to risk tier.
     */
    computeRiskTier(finalScore) {
        const { tiers } = this.config;
        if (finalScore === 0)
            return 'UNKNOWN';
        if (finalScore < tiers.low)
            return 'LOW';
        if (finalScore < tiers.standard)
            return 'STANDARD';
        if (finalScore < tiers.trusted)
            return 'TRUSTED';
        return 'ELITE';
    }
    // ─── Full Snapshot ────────────────────────────────────────────────────────────
    /**
     * Compute a full ReputationSnapshot from address metrics.
     */
    computeSnapshot(metrics, blockNumber, nowMs) {
        const now = nowMs ?? Date.now();
        const scores = this.computeScores(metrics, now);
        const behaviorTags = this.computeTags(metrics);
        const riskTier = this.computeRiskTier(scores.final);
        // Deterministic snapshot ID
        const snapshotId = this.computeSnapshotId(metrics.address, metrics.chainId, blockNumber ?? Math.floor(now / 1000));
        return {
            address: metrics.address,
            chainId: metrics.chainId,
            snapshotId,
            scores,
            metrics: {
                totalIntents: metrics.totalIntentsSubmitted,
                successRate: metrics.successRate,
                totalVolumeUSD: metrics.totalVolumeUSD,
                avgAlphaScore: metrics.alphaTradeCount > 0
                    ? metrics.alphaScoreSum / metrics.alphaTradeCount
                    : 0,
                uniqueSkillsUsed: metrics.uniqueSkillsUsed,
                activeWeeks: metrics.activeWeeks,
            },
            behaviorTags,
            riskTier,
            computedAt: now,
            validUntil: now + 24 * 60 * 60 * 1000, // 24h TTL
            blockNumber,
        };
    }
    // ─── Incremental Update ───────────────────────────────────────────────────────
    /**
     * Incrementally update metrics when a new intent event arrives.
     * Avoids full recomputation for real-time updates.
     */
    applyIntentEvent(metrics, event) {
        const updated = { ...metrics };
        const now = Date.now();
        updated.totalIntentsSubmitted += 1;
        updated.totalVolumeUSD += event.inputAmountUSD;
        updated.lastIntentAt = now;
        updated.updatedAt = now;
        if (updated.firstIntentAt === 0)
            updated.firstIntentAt = now;
        if (event.inputAmountUSD > updated.largestSingleTradeUSD) {
            updated.largestSingleTradeUSD = event.inputAmountUSD;
        }
        switch (event.status) {
            case 'SUCCESS':
                updated.totalIntentsSucceeded += 1;
                if (event.actualSlippageBps !== undefined) {
                    updated.avgSlippageBps = ((updated.avgSlippageBps * (updated.totalIntentsSucceeded - 1) + event.actualSlippageBps)
                        / updated.totalIntentsSucceeded);
                }
                break;
            case 'FAILED':
                updated.totalIntentsFailed += 1;
                break;
            case 'EXPIRED':
                updated.totalIntentsExpired += 1;
                break;
        }
        if (event.alphaScore !== undefined) {
            updated.alphaScoreSum += event.alphaScore;
            updated.alphaTradeCount += 1;
        }
        // Recompute success rate
        updated.successRate = updated.totalIntentsSubmitted > 0
            ? updated.totalIntentsSucceeded / updated.totalIntentsSubmitted
            : 0;
        return updated;
    }
    // ─── Helpers ──────────────────────────────────────────────────────────────────
    computeSnapshotId(address, chainId, blockOrTime) {
        const input = `${address.toLowerCase()}:${chainId}:${blockOrTime}`;
        return '0x' + (0, crypto_1.createHash)('sha256').update(input).digest('hex').slice(0, 64);
    }
    /**
     * Create empty metrics for a new address.
     */
    static emptyMetrics(address, chainId) {
        return {
            address: address.toLowerCase(),
            chainId,
            totalIntentsSubmitted: 0,
            totalIntentsSucceeded: 0,
            totalIntentsFailed: 0,
            totalIntentsExpired: 0,
            totalVolumeUSD: 0,
            largestSingleTradeUSD: 0,
            successRate: 0,
            avgSlippageBps: 0,
            avgExecutionTimeMs: 0,
            alphaScoreSum: 0,
            alphaTradeCount: 0,
            uniqueTokensTraded: 0,
            uniqueSkillsUsed: 0,
            uniqueSolversUsed: 0,
            uniqueChainsUsed: 0,
            firstIntentAt: 0,
            lastIntentAt: 0,
            activeWeeks: 0,
            updatedAt: Date.now(),
        };
    }
}
exports.ScoringEngine = ScoringEngine;
//# sourceMappingURL=scoringEngine.js.map