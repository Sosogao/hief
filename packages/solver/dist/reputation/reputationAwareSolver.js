"use strict";
/**
 * HIEF Reputation-Aware Solver
 *
 * Wraps the CoW adapter with reputation-based adjustments:
 *  1. Fetch user reputation params
 *  2. Apply spread multiplier to fee
 *  3. Attach solver selection hints to the solution
 *  4. Log priority score for intent routing
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReputationAwareSolver = void 0;
exports.getReputationAwareSolver = getReputationAwareSolver;
const cowAdapter_1 = require("../adapters/cowAdapter");
const reputationSolverAdapter_1 = require("./reputationSolverAdapter");
class ReputationAwareSolver {
    repAdapter;
    solverId;
    constructor(solverId = process.env.SOLVER_ID ?? 'hief-default-solver') {
        this.repAdapter = (0, reputationSolverAdapter_1.getReputationSolverAdapter)();
        this.solverId = solverId;
    }
    /**
     * Solve an intent with reputation-aware adjustments.
     */
    async solve(intent) {
        // 1. Fetch reputation params for the user
        const repParams = await this.repAdapter.getSolverParams(intent.smartAccount);
        // 2. Get base CoW quote
        const quote = await (0, cowAdapter_1.getCowQuote)(intent);
        if (!quote) {
            return {
                solution: null,
                reputationParams: repParams,
                adjustmentNote: 'CoW quote unavailable',
                priorityScore: repParams.priorityScore,
            };
        }
        // 3. Apply reputation adjustments to the quote
        const adjusted = this.repAdapter.applyReputationToQuote(repParams, {
            sellAmount: quote.sellAmount,
            buyAmount: quote.buyAmount,
            feeAmount: quote.feeAmount,
        });
        // 4. Build solution with adjusted amounts
        const adjustedQuote = {
            ...quote,
            buyAmount: adjusted.adjustedBuyAmount,
            feeAmount: adjusted.adjustedFeeAmount,
        };
        const solution = (0, cowAdapter_1.buildSolutionFromCowQuote)(intent, adjustedQuote, this.solverId);
        // 5. Attach reputation context to solution meta
        solution.reputationContext = {
            tier: repParams.tier,
            score: repParams.score,
            priorityScore: repParams.priorityScore,
            spreadMultiplier: repParams.spreadMultiplier,
            settlementSpeed: repParams.settlementSpeed,
            requireSimulation: repParams.requireSimulation,
            adjustmentNote: adjusted.note,
        };
        // 6. Attach solver selection hints
        const hints = this.repAdapter.buildSolverSelectionHints(repParams);
        solution.solverHints = hints;
        return {
            solution,
            reputationParams: repParams,
            adjustmentNote: adjusted.note,
            priorityScore: repParams.priorityScore,
        };
    }
}
exports.ReputationAwareSolver = ReputationAwareSolver;
// ── Singleton ─────────────────────────────────────────────────────────────────
let _solver = null;
function getReputationAwareSolver() {
    if (!_solver)
        _solver = new ReputationAwareSolver();
    return _solver;
}
//# sourceMappingURL=reputationAwareSolver.js.map