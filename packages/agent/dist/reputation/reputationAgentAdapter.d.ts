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
export type ReputationTier = 'UNKNOWN' | 'NEWCOMER' | 'TRUSTED' | 'ELITE';
export interface UserReputationContext {
    tier: ReputationTier;
    score: number;
    behaviorTags: string[];
    maxSlippageBps: number;
    maxFeeBps: number;
    dailyLimitUsd: number;
    requireSimulation: boolean;
    riskWarnings: string[];
    tierBadge: string;
    tierDescription: string;
}
export declare class ReputationAgentAdapter {
    private readonly baseUrl;
    private readonly timeoutMs;
    constructor(baseUrl?: string, timeoutMs?: number);
    /**
     * Fetch reputation context for a user address.
     * Falls back to UNKNOWN tier on any error.
     */
    getUserContext(address: string): Promise<UserReputationContext>;
    /**
     * Build a tier-aware system prompt suffix to inject into the AI conversation.
     * This shapes how the AI presents risk information to the user.
     */
    buildSystemPromptSuffix(ctx: UserReputationContext): string;
    /**
     * Build a tier badge line for the confirmation message shown to the user.
     */
    buildConfirmationHeader(ctx: UserReputationContext): string;
    private _buildRiskWarnings;
    private _unknownContext;
}
export declare function getReputationAgentAdapter(): ReputationAgentAdapter;
export declare function resetReputationAgentAdapter(): void;
//# sourceMappingURL=reputationAgentAdapter.d.ts.map