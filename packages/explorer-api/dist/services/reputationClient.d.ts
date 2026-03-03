/**
 * ReputationClient — HTTP client for the Reputation API service.
 */
export interface ReputationSnapshot {
    address: string;
    chainId: number;
    snapshotId: string;
    scores: {
        successScore: number;
        volumeScore: number;
        alphaScore: number;
        diversityScore: number;
        composite: number;
        decayFactor: number;
        final: number;
    };
    metrics: {
        totalIntents: number;
        successRate: number;
        totalVolumeUSD: number;
        avgAlphaScore: number;
        uniqueSkillsUsed: number;
        activeWeeks: number;
    };
    behaviorTags: string[];
    riskTier: string;
    computedAt: number;
    validUntil: number;
}
export interface LeaderboardEntry {
    address: string;
    finalScore: number;
    riskTier: string;
    successRate: number | null;
    totalIntents: number;
}
export declare function getReputation(address: string, chainId: number): Promise<ReputationSnapshot | null>;
export declare function getReputationHistory(address: string, chainId: number, limit?: number): Promise<any[]>;
export declare function getLeaderboard(chainId: number, limit?: number): Promise<LeaderboardEntry[]>;
export declare function checkReputationHealth(): Promise<boolean>;
//# sourceMappingURL=reputationClient.d.ts.map