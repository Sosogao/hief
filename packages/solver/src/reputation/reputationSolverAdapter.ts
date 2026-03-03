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

import axios from 'axios';

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

// ── Tier configuration ────────────────────────────────────────────────────────

const TIER_CONFIG: Record<ReputationTier, Omit<SolverReputationParams, 'tier' | 'score'>> = {
  ELITE: {
    priorityScore: 95,
    spreadMultiplier: 0.8,    // 20% tighter spread — reward loyal users
    maxSlippageBps: 500,
    requireSimulation: false,
    settlementSpeed: 'FAST',
    minSolverRepScore: 0,     // any solver can serve
  },
  TRUSTED: {
    priorityScore: 70,
    spreadMultiplier: 1.0,
    maxSlippageBps: 200,
    requireSimulation: false,
    settlementSpeed: 'STANDARD',
    minSolverRepScore: 0,
  },
  NEWCOMER: {
    priorityScore: 40,
    spreadMultiplier: 1.1,    // 10% wider spread — risk buffer
    maxSlippageBps: 100,
    requireSimulation: true,
    settlementSpeed: 'STANDARD',
    minSolverRepScore: 0,
  },
  UNKNOWN: {
    priorityScore: 20,
    spreadMultiplier: 1.2,    // 20% wider spread
    maxSlippageBps: 50,
    requireSimulation: true,
    settlementSpeed: 'CONSERVATIVE',
    minSolverRepScore: 0,
  },
};

// ── Adapter ───────────────────────────────────────────────────────────────────

export class ReputationSolverAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    baseUrl = process.env.REPUTATION_API_URL ?? 'http://localhost:3002',
    timeoutMs = 2_000
  ) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Fetch solver reputation params for a user address.
   * Falls back to UNKNOWN tier on any error.
   */
  async getSolverParams(userAddress: string): Promise<SolverReputationParams> {
    try {
      const { data } = await axios.get(
        `${this.baseUrl}/v1/reputation/${userAddress}`,
        { timeout: this.timeoutMs }
      );

      const tier: ReputationTier = data.tier ?? 'UNKNOWN';
      const score: number = data.compositeScore ?? 0;
      const config = TIER_CONFIG[tier];

      // Fine-tune priority score based on exact score within tier
      const adjustedPriority = this._adjustPriorityByScore(config.priorityScore, score, tier);

      const { priorityScore: _base, ...restConfig } = config;
      return {
        tier,
        score,
        priorityScore: adjustedPriority,
        ...restConfig,
      };
    } catch {
      return this._unknownParams();
    }
  }

  /**
   * Apply reputation-based adjustments to a CoW Protocol quote.
   * Returns the adjusted quote parameters.
   */
  applyReputationToQuote(
    params: SolverReputationParams,
    quote: {
      sellAmount: string;
      buyAmount: string;
      feeAmount: string;
    }
  ): {
    adjustedBuyAmount: string;
    adjustedFeeAmount: string;
    spreadMultiplier: number;
    note: string;
  } {
    const buyAmountBigInt = BigInt(quote.buyAmount);
    const feeAmountBigInt = BigInt(quote.feeAmount);

    // Apply spread multiplier to fee (not to buy amount — that's market-determined)
    // spreadMultiplier < 1.0 means we reduce fee for elite users
    // spreadMultiplier > 1.0 means we add buffer for unknown users
    const multiplierBps = Math.round(params.spreadMultiplier * 10_000);
    const adjustedFee = (feeAmountBigInt * BigInt(multiplierBps)) / BigInt(10_000);

    // For elite users, also slightly improve buy amount (better execution)
    let adjustedBuy = buyAmountBigInt;
    if (params.tier === 'ELITE') {
      // 0.1% bonus on buy amount for elite users
      adjustedBuy = (buyAmountBigInt * BigInt(10_010)) / BigInt(10_000);
    }

    const notes: Record<ReputationTier, string> = {
      ELITE: `Elite tier: reduced fee (×${params.spreadMultiplier}), +0.1% buy bonus`,
      TRUSTED: `Trusted tier: standard execution`,
      NEWCOMER: `Newcomer tier: +10% fee buffer for risk management`,
      UNKNOWN: `Unknown tier: +20% fee buffer, simulation required`,
    };

    return {
      adjustedBuyAmount: adjustedBuy.toString(),
      adjustedFeeAmount: adjustedFee.toString(),
      spreadMultiplier: params.spreadMultiplier,
      note: notes[params.tier],
    };
  }

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
  } {
    return {
      priorityScore: params.priorityScore,
      settlementSpeed: params.settlementSpeed,
      requireSimulation: params.requireSimulation,
      maxSlippageBps: params.maxSlippageBps,
      minSolverRepScore: params.minSolverRepScore,
      tierLabel: params.tier,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _adjustPriorityByScore(
    basePriority: number,
    score: number,
    tier: ReputationTier
  ): number {
    // Fine-tune within tier: score within tier range adds up to ±10 points
    const tierRanges: Record<ReputationTier, [number, number]> = {
      UNKNOWN: [0, 100],
      NEWCOMER: [100, 300],
      TRUSTED: [300, 600],
      ELITE: [600, 1000],
    };

    const [min, max] = tierRanges[tier];
    const rangeSize = max - min;
    if (rangeSize === 0) return basePriority;

    const positionInTier = Math.min(Math.max(score - min, 0), rangeSize) / rangeSize;
    const adjustment = Math.round(positionInTier * 10) - 5; // -5 to +5
    return Math.min(100, Math.max(0, basePriority + adjustment));
  }

  private _unknownParams(): SolverReputationParams {
    return {
      tier: 'UNKNOWN',
      score: 0,
      ...TIER_CONFIG['UNKNOWN'],
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _adapter: ReputationSolverAdapter | null = null;

export function getReputationSolverAdapter(): ReputationSolverAdapter {
  if (!_adapter) _adapter = new ReputationSolverAdapter();
  return _adapter;
}

export function resetReputationSolverAdapter(): void {
  _adapter = null;
}
