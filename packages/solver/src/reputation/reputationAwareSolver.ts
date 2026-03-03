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
import { getCowQuote, buildSolutionFromCowQuote } from '../adapters/cowAdapter';
import {
  ReputationSolverAdapter,
  SolverReputationParams,
  getReputationSolverAdapter,
} from './reputationSolverAdapter';

export interface ReputationAwareSolveResult {
  solution: HIEFSolution | null;
  reputationParams: SolverReputationParams;
  adjustmentNote: string;
  priorityScore: number;
}

export class ReputationAwareSolver {
  private readonly repAdapter: ReputationSolverAdapter;
  private readonly solverId: string;

  constructor(solverId = process.env.SOLVER_ID ?? 'hief-default-solver') {
    this.repAdapter = getReputationSolverAdapter();
    this.solverId = solverId;
  }

  /**
   * Solve an intent with reputation-aware adjustments.
   */
  async solve(intent: HIEFIntent): Promise<ReputationAwareSolveResult> {
    // 1. Fetch reputation params for the user
    const repParams = await this.repAdapter.getSolverParams(intent.smartAccount);

    // 2. Get base CoW quote
    const quote = await getCowQuote(intent);
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

    const solution = buildSolutionFromCowQuote(intent, adjustedQuote, this.solverId);

    // 5. Attach reputation context to solution meta
    (solution as any).reputationContext = {
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
    (solution as any).solverHints = hints;

    return {
      solution,
      reputationParams: repParams,
      adjustmentNote: adjusted.note,
      priorityScore: repParams.priorityScore,
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _solver: ReputationAwareSolver | null = null;

export function getReputationAwareSolver(): ReputationAwareSolver {
  if (!_solver) _solver = new ReputationAwareSolver();
  return _solver;
}
