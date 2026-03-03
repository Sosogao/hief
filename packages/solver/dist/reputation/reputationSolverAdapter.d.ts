/**
 * HIEF Reputation-Aware Solver Adapter
 *
 * Adjusts solver behavior based on the user's reputation tier:
 *
 *  - ELITE:    Priority queue, tighter spread, faster settlement
 *  - TRUSTED:  Standard queue, normal spread
 *  - NEWCOMER: Standard queue, wider spread (risk buffer)
 *  - UNKNOWN:  Conservative queue, widest spread, simulation required
 *
 * The adapter also computes a "priority score" that determines how
 * quickly solvers respond to an intent in a competitive network.
 */
export type ReputationTier = 'UNKNOWN' | 'NEWCOMER' | 'TRUSTED' | 'ELITE';
export interface SolverReputationParams {
    tier: ReputationTier;
    score: number;
    /** Priority score 0-100: higher = faster solver response */
    priorityScore: number;
    /** Spread multiplier applied to solver quotes: 1.0 = standard */
    spreadMultiplier: number;
    /** Max slippage bps the solver is allowed to use */
    maxSlippageBps: number;
    /** Whether solver must run simulation before submitting solution */
    requireSimulation: boolean;
    /** Settlement speed hint for solver scheduling */
    settlementSpeed: 'FAST' | 'STANDARD' | 'CONSERVATIVE';
    /** Minimum solver reputation score required to serve this intent */
    minSolverRepScore: number;
}
export declare class ReputationSolverAdapter {
    private readonly baseUrl;
    private readonly timeoutMs;
    constructor(baseUrl?: string, timeoutMs?: number);
    /**
     * Fetch solver reputation params for a user address.
     * Falls back to UNKNOWN tier on any error.
     */
    getSolverParams(userAddress: string): Promise<SolverReputationParams>;
    /**
     * Apply reputation-based adjustments to a CoW Protocol quote.
     * Returns the adjusted quote parameters.
     */
    applyReputationToQuote(params: SolverReputationParams, quote: {
        sellAmount: string;
        buyAmount: string;
        feeAmount: string;
    }): {
        adjustedBuyAmount: string;
        adjustedFeeAmount: string;
        spreadMultiplier: number;
        note: string;
    };
    /**
     * Build a priority-sorted solver selection header.
     * Used by the Intent Bus to route intents to appropriate solvers.
     */
    buildSolverSelectionHints(params: SolverReputationParams): {
        priorityScore: number;
        settlementSpeed: string;
        requireSimulation: boolean;
        maxSlippageBps: number;
        minSolverRepScore: number;
        tierLabel: string;
    };
    private _adjustPriorityByScore;
    private _unknownParams;
}
export declare function getReputationSolverAdapter(): ReputationSolverAdapter;
export declare function resetReputationSolverAdapter(): void;
//# sourceMappingURL=reputationSolverAdapter.d.ts.map