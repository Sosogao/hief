"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReputationSolverAdapter = void 0;
exports.getReputationSolverAdapter = getReputationSolverAdapter;
exports.resetReputationSolverAdapter = resetReputationSolverAdapter;
const axios_1 = __importDefault(require("axios"));
// ── Tier configuration ────────────────────────────────────────────────────────
const TIER_CONFIG = {
    ELITE: {
        priorityScore: 95,
        spreadMultiplier: 0.8, // 20% tighter spread — reward loyal users
        maxSlippageBps: 500,
        requireSimulation: false,
        settlementSpeed: 'FAST',
        minSolverRepScore: 0, // any solver can serve
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
        spreadMultiplier: 1.1, // 10% wider spread — risk buffer
        maxSlippageBps: 100,
        requireSimulation: true,
        settlementSpeed: 'STANDARD',
        minSolverRepScore: 0,
    },
    UNKNOWN: {
        priorityScore: 20,
        spreadMultiplier: 1.2, // 20% wider spread
        maxSlippageBps: 50,
        requireSimulation: true,
        settlementSpeed: 'CONSERVATIVE',
        minSolverRepScore: 0,
    },
};
// ── Adapter ───────────────────────────────────────────────────────────────────
class ReputationSolverAdapter {
    baseUrl;
    timeoutMs;
    constructor(baseUrl = process.env.REPUTATION_API_URL ?? 'http://localhost:3002', timeoutMs = 2_000) {
        this.baseUrl = baseUrl;
        this.timeoutMs = timeoutMs;
    }
    /**
     * Fetch solver reputation params for a user address.
     * Falls back to UNKNOWN tier on any error.
     */
    async getSolverParams(userAddress) {
        try {
            const { data } = await axios_1.default.get(`${this.baseUrl}/v1/reputation/${userAddress}`, { timeout: this.timeoutMs });
            const tier = data.tier ?? 'UNKNOWN';
            const score = data.compositeScore ?? 0;
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
        }
        catch {
            return this._unknownParams();
        }
    }
    /**
     * Apply reputation-based adjustments to a CoW Protocol quote.
     * Returns the adjusted quote parameters.
     */
    applyReputationToQuote(params, quote) {
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
        const notes = {
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
    buildSolverSelectionHints(params) {
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
    _adjustPriorityByScore(basePriority, score, tier) {
        // Fine-tune within tier: score within tier range adds up to ±10 points
        const tierRanges = {
            UNKNOWN: [0, 100],
            NEWCOMER: [100, 300],
            TRUSTED: [300, 600],
            ELITE: [600, 1000],
        };
        const [min, max] = tierRanges[tier];
        const rangeSize = max - min;
        if (rangeSize === 0)
            return basePriority;
        const positionInTier = Math.min(Math.max(score - min, 0), rangeSize) / rangeSize;
        const adjustment = Math.round(positionInTier * 10) - 5; // -5 to +5
        return Math.min(100, Math.max(0, basePriority + adjustment));
    }
    _unknownParams() {
        return {
            tier: 'UNKNOWN',
            score: 0,
            ...TIER_CONFIG['UNKNOWN'],
        };
    }
}
exports.ReputationSolverAdapter = ReputationSolverAdapter;
// ── Singleton ─────────────────────────────────────────────────────────────────
let _adapter = null;
function getReputationSolverAdapter() {
    if (!_adapter)
        _adapter = new ReputationSolverAdapter();
    return _adapter;
}
function resetReputationSolverAdapter() {
    _adapter = null;
}
//# sourceMappingURL=reputationSolverAdapter.js.map