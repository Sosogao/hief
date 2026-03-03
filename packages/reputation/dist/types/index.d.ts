/**
 * HIEF Reputation Layer Types (HIEF-REP-01)
 *
 * Defines all data structures for the Intent Reputation Layer.
 * This is the "moat core" — data that cannot be forked.
 */
export interface IntentRecord {
    intentId: string;
    address: string;
    chainId: number;
    intentType: string;
    inputToken: string;
    outputToken: string;
    inputAmountUSD: number;
    status: 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
    submittedAt: number;
    executedAt?: number;
    solverUsed?: string;
    actualSlippageBps?: number;
    gasUsedUSD?: number;
    alphaScore?: number;
    skillId?: string;
}
export interface AddressMetrics {
    address: string;
    chainId: number;
    totalIntentsSubmitted: number;
    totalIntentsSucceeded: number;
    totalIntentsFailed: number;
    totalIntentsExpired: number;
    totalVolumeUSD: number;
    largestSingleTradeUSD: number;
    successRate: number;
    avgSlippageBps: number;
    avgExecutionTimeMs: number;
    alphaScoreSum: number;
    alphaTradeCount: number;
    uniqueTokensTraded: number;
    uniqueSkillsUsed: number;
    uniqueSolversUsed: number;
    uniqueChainsUsed: number;
    firstIntentAt: number;
    lastIntentAt: number;
    activeWeeks: number;
    updatedAt: number;
}
export type BehaviorTag = 'HIGH_FREQUENCY_TRADER' | 'WHALE' | 'ALPHA_HUNTER' | 'LONG_TERM_HOLDER' | 'DIVERSIFIED' | 'PROTOCOL_NATIVE' | 'RELIABLE' | 'EARLY_ADOPTER' | 'MULTI_CHAIN' | 'LOW_SLIPPAGE_OPTIMIZER';
export interface ReputationScores {
    successScore: number;
    volumeScore: number;
    alphaScore: number;
    diversityScore: number;
    composite: number;
    decayFactor: number;
    final: number;
}
export interface ReputationSnapshot {
    address: string;
    chainId: number;
    snapshotId: string;
    scores: ReputationScores;
    metrics: {
        totalIntents: number;
        successRate: number;
        totalVolumeUSD: number;
        avgAlphaScore: number;
        uniqueSkillsUsed: number;
        activeWeeks: number;
    };
    behaviorTags: BehaviorTag[];
    riskTier: 'UNKNOWN' | 'LOW' | 'STANDARD' | 'TRUSTED' | 'ELITE';
    onChainTokenId?: number;
    onChainScore?: number;
    computedAt: number;
    validUntil: number;
    blockNumber?: number;
}
export interface ScoringConfig {
    weights: {
        success: number;
        volume: number;
        alpha: number;
        diversity: number;
    };
    decayHalfLifeDays: number;
    minDecayFactor: number;
    tiers: {
        low: number;
        standard: number;
        trusted: number;
        elite: number;
    };
    tags: {
        highFrequencyWeeklyIntents: number;
        whaleTradeUSD: number;
        alphaHunterAvgScore: number;
        reliableSuccessRate: number;
        diversifiedTokenCount: number;
        protocolNativeSkillCount: number;
        multiChainCount: number;
        lowSlippageBps: number;
    };
}
export declare const DEFAULT_SCORING_CONFIG: ScoringConfig;
export interface ReputationQueryResult {
    snapshot: ReputationSnapshot;
    cached: boolean;
    source: 'cache' | 'computed' | 'onchain';
}
export interface IntentEventPayload {
    intentId: string;
    address: string;
    chainId: number;
    status: IntentRecord['status'];
    inputAmountUSD: number;
    intentType: string;
    inputToken: string;
    outputToken: string;
    alphaScore?: number;
    skillId?: string;
    executedAt?: number;
    actualSlippageBps?: number;
}
//# sourceMappingURL=index.d.ts.map