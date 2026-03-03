/**
 * HIEF Reputation Layer Types (HIEF-REP-01)
 *
 * Defines all data structures for the Intent Reputation Layer.
 * This is the "moat core" — data that cannot be forked.
 */

// ─── Raw Metrics (stored off-chain) ──────────────────────────────────────────

export interface IntentRecord {
  intentId: string;
  address: string;
  chainId: number;
  intentType: string;
  inputToken: string;
  outputToken: string;
  inputAmountUSD: number;
  status: 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
  submittedAt: number;       // Unix timestamp
  executedAt?: number;       // Unix timestamp (if executed)
  solverUsed?: string;       // Solver address
  actualSlippageBps?: number;
  gasUsedUSD?: number;
  alphaScore?: number;       // 0-100: how "alpha" was this trade (vs market timing)
  skillId?: string;          // Which Skill generated this intent
}

export interface AddressMetrics {
  address: string;
  chainId: number;

  // Volume & Activity
  totalIntentsSubmitted: number;
  totalIntentsSucceeded: number;
  totalIntentsFailed: number;
  totalIntentsExpired: number;
  totalVolumeUSD: number;
  largestSingleTradeUSD: number;

  // Quality
  successRate: number;         // 0-1
  avgSlippageBps: number;
  avgExecutionTimeMs: number;

  // Alpha
  alphaScoreSum: number;
  alphaTradeCount: number;

  // Diversity
  uniqueTokensTraded: number;
  uniqueSkillsUsed: number;
  uniqueSolversUsed: number;
  uniqueChainsUsed: number;

  // Temporal
  firstIntentAt: number;
  lastIntentAt: number;
  activeWeeks: number;         // Number of distinct weeks with activity

  // Computed
  updatedAt: number;
}

// ─── Behavior Tags ────────────────────────────────────────────────────────────

export type BehaviorTag =
  | 'HIGH_FREQUENCY_TRADER'   // > 50 intents/week
  | 'WHALE'                   // > $100k single trade
  | 'ALPHA_HUNTER'            // alphaScore avg > 70
  | 'LONG_TERM_HOLDER'        // avg hold time > 30 days
  | 'DIVERSIFIED'             // > 10 unique tokens
  | 'PROTOCOL_NATIVE'         // uses > 3 different Skills
  | 'RELIABLE'                // success rate > 95%
  | 'EARLY_ADOPTER'           // first intent < 30 days after protocol launch
  | 'MULTI_CHAIN'             // active on > 2 chains
  | 'LOW_SLIPPAGE_OPTIMIZER'; // avg slippage < 20bps

// ─── Reputation Score (HIEF-REP-01 §3) ───────────────────────────────────────

export interface ReputationScores {
  // Four-dimensional weighted score (each 0-1000)
  successScore: number;    // S_score: based on success rate
  volumeScore: number;     // V_score: log-compressed volume
  alphaScore: number;      // A_score: alpha contribution
  diversityScore: number;  // D_score: ecosystem diversity

  // Composite (weighted average, 0-1000)
  composite: number;

  // Time-decay factor (0-1, decreases with inactivity)
  decayFactor: number;

  // Final score after decay (0-1000)
  final: number;
}

export interface ReputationSnapshot {
  // Identity
  address: string;
  chainId: number;
  snapshotId: string;      // Deterministic: keccak256(address + chainId + blockNumber)

  // Scores
  scores: ReputationScores;

  // Raw metrics summary
  metrics: {
    totalIntents: number;
    successRate: number;
    totalVolumeUSD: number;
    avgAlphaScore: number;
    uniqueSkillsUsed: number;
    activeWeeks: number;
  };

  // Behavior tags
  behaviorTags: BehaviorTag[];

  // Risk tier (derived from composite score)
  riskTier: 'UNKNOWN' | 'LOW' | 'STANDARD' | 'TRUSTED' | 'ELITE';

  // On-chain reference
  onChainTokenId?: number;    // ERC-721 token ID (if minted)
  onChainScore?: number;      // Score stored on-chain (may lag off-chain)

  // Timestamps
  computedAt: number;
  validUntil: number;         // Snapshot expires after 24h
  blockNumber?: number;
}

// ─── Score Computation Config ─────────────────────────────────────────────────

export interface ScoringConfig {
  // Weights (must sum to 1.0)
  weights: {
    success: number;    // default: 0.35
    volume: number;     // default: 0.30
    alpha: number;      // default: 0.20
    diversity: number;  // default: 0.15
  };

  // Decay
  decayHalfLifeDays: number;   // default: 180 (score halves after 180 days inactive)
  minDecayFactor: number;      // default: 0.1 (never below 10%)

  // Thresholds for risk tiers
  tiers: {
    low: number;       // default: 100  — [0,100) = LOW
    standard: number;  // default: 300  — [100,300) = STANDARD
    trusted: number;   // default: 600  — [300,600) = TRUSTED
    elite: number;     // default: 850  — [600,850) = ELITE, [850,∞) = ELITE
  };

  // Tag thresholds
  tags: {
    highFrequencyWeeklyIntents: number;  // default: 50
    whaleTradeUSD: number;               // default: 100000
    alphaHunterAvgScore: number;         // default: 70
    reliableSuccessRate: number;         // default: 0.95
    diversifiedTokenCount: number;       // default: 10
    protocolNativeSkillCount: number;    // default: 3
    multiChainCount: number;             // default: 2
    lowSlippageBps: number;              // default: 20
  };
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: { success: 0.35, volume: 0.30, alpha: 0.20, diversity: 0.15 },
  decayHalfLifeDays: 180,
  minDecayFactor: 0.1,
  tiers: { low: 100, standard: 300, trusted: 600, elite: 850 }, // trusted=[300,600), elite=[600,∞)
  tags: {
    highFrequencyWeeklyIntents: 50,
    whaleTradeUSD: 100000,
    alphaHunterAvgScore: 70,
    reliableSuccessRate: 0.95,
    diversifiedTokenCount: 10,
    protocolNativeSkillCount: 3,
    multiChainCount: 2,
    lowSlippageBps: 20,
  },
};

// ─── API Types ────────────────────────────────────────────────────────────────

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
