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
export type ReputationTier = 'UNKNOWN' | 'NEWCOMER' | 'TRUSTED' | 'ELITE';
export interface DynamicPolicyParams {
    tier: ReputationTier;
    score: number;
    maxSlippageBps: number;
    maxFeeBps: number;
    requireSimulation: boolean;
    dailyLimitUsd: number;
    behaviorTags: string[];
    riskWarnings: string[];
}
export interface ReputationSnapshot {
    address: string;
    compositeScore: number;
    tier: ReputationTier;
    behaviorTags: string[];
    metrics: {
        totalIntents: number;
        successRate: number;
        totalVolumeUsd: number;
        daysSinceLastActive: number;
    };
}
export declare class ReputationPolicyAdapter {
    private readonly baseUrl;
    private readonly timeoutMs;
    constructor(baseUrl?: string, timeoutMs?: number);
    /**
     * Fetch reputation snapshot and compute dynamic policy parameters.
     * Falls back to UNKNOWN tier on any error.
     */
    getPolicyParams(address: string): Promise<DynamicPolicyParams>;
    /**
     * Build DynamicPolicyParams from a snapshot (or null for UNKNOWN).
     */
    private _buildParams;
}
export declare function getReputationPolicyAdapter(): ReputationPolicyAdapter;
export declare function resetReputationPolicyAdapter(): void;
//# sourceMappingURL=reputationPolicyAdapter.d.ts.map