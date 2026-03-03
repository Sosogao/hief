/**
 * HIEF Reputation-Aware Solver
 *
 * Wraps the CoW adapter with reputation-based adjustments:
 *  1. Fetch user reputation params
 *  2. Apply spread multiplier to fee
 *  3. Attach solver selection hints to the solution
 *  4. Log priority score for intent routing
 */
import type { HIEFIntent, HIEFSolution } from '@hief/common';
import { SolverReputationParams } from './reputationSolverAdapter';
export interface ReputationAwareSolveResult {
    solution: HIEFSolution | null;
    reputationParams: SolverReputationParams;
    adjustmentNote: string;
    priorityScore: number;
}
export declare class ReputationAwareSolver {
    private readonly repAdapter;
    private readonly solverId;
    constructor(solverId?: string);
    /**
     * Solve an intent with reputation-aware adjustments.
     */
    solve(intent: HIEFIntent): Promise<ReputationAwareSolveResult>;
}
export declare function getReputationAwareSolver(): ReputationAwareSolver;
//# sourceMappingURL=reputationAwareSolver.d.ts.map