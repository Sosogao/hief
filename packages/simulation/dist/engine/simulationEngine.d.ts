/**
 * HIEF Simulation Engine — L4 Policy Layer
 *
 * Orchestrates the full L4 verification flow:
 *  1. Build Tenderly simulation request from HIEF Solution
 *  2. Execute simulation via TenderlyClient
 *  3. Parse response into ExecutionDiff via DiffEngine
 *  4. Run simulation-specific policy rules against the diff
 *  5. Return SimulationPolicyResult
 *
 * Graceful degradation: if Tenderly is unavailable, returns SKIP (not FAIL).
 * This ensures the system remains operational without Tenderly credentials.
 */
import { SimulationPolicyResult, SimulationRulesConfig } from '../types';
import { TenderlyClient } from '../tenderly/tenderlyClient';
interface Call {
    to: string;
    data: string;
    value?: string;
    operation?: number;
}
interface HIEFSolution {
    intentHash: string;
    solutionHash: string;
    solver: string;
    executionPlan: {
        safeAddress: string;
        calls: Call[];
        nonce: number;
        chainId: number;
    };
    quote: {
        inputToken: string;
        inputAmount: string;
        outputToken: string;
        outputAmount: string;
        slippageBps: number;
        quoteUsd?: number;
    };
    signature: string;
}
export declare class SimulationEngine {
    private readonly tenderly;
    private readonly diffEngine;
    private readonly rules;
    constructor(tenderly: TenderlyClient | null, rules?: Partial<SimulationRulesConfig>);
    /**
     * Run L4 simulation verification for a given HIEF Solution.
     * Returns SKIP if Tenderly is unavailable.
     */
    verify(solution: HIEFSolution): Promise<SimulationPolicyResult>;
    private _buildSimRequests;
    private _runRules;
    private _skipResult;
}
export {};
//# sourceMappingURL=simulationEngine.d.ts.map