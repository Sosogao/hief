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
import type { AddressMetrics, ReputationScores, ReputationSnapshot, BehaviorTag, ScoringConfig } from '../types';
export declare class ScoringEngine {
    private config;
    constructor(config?: Partial<ScoringConfig>);
    /**
     * Compute all four dimension scores from address metrics.
     */
    computeScores(metrics: AddressMetrics, nowMs?: number): ReputationScores;
    /**
     * Derive behavior tags from metrics.
     */
    computeTags(metrics: AddressMetrics): BehaviorTag[];
    /**
     * Map final score to risk tier.
     */
    computeRiskTier(finalScore: number): ReputationSnapshot['riskTier'];
    /**
     * Compute a full ReputationSnapshot from address metrics.
     */
    computeSnapshot(metrics: AddressMetrics, blockNumber?: number, nowMs?: number): ReputationSnapshot;
    /**
     * Incrementally update metrics when a new intent event arrives.
     * Avoids full recomputation for real-time updates.
     */
    applyIntentEvent(metrics: AddressMetrics, event: {
        status: 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
        inputAmountUSD: number;
        alphaScore?: number;
        skillId?: string;
        actualSlippageBps?: number;
        executedAt?: number;
        inputToken?: string;
        outputToken?: string;
        chainId?: number;
    }): AddressMetrics;
    private computeSnapshotId;
    /**
     * Create empty metrics for a new address.
     */
    static emptyMetrics(address: string, chainId: number): AddressMetrics;
}
//# sourceMappingURL=scoringEngine.d.ts.map