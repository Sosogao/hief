"use strict";
/**
 * HIEF Reputation Layer Types (HIEF-REP-01)
 *
 * Defines all data structures for the Intent Reputation Layer.
 * This is the "moat core" — data that cannot be forked.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SCORING_CONFIG = void 0;
exports.DEFAULT_SCORING_CONFIG = {
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
//# sourceMappingURL=index.js.map