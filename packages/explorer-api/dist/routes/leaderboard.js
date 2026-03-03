"use strict";
/**
 * Leaderboard routes for Explorer API.
 *
 * GET /v1/explorer/leaderboard  — top addresses by reputation score
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.leaderboardRouter = void 0;
const express_1 = require("express");
const reputationClient_1 = require("../services/reputationClient");
const busClient_1 = require("../services/busClient");
exports.leaderboardRouter = (0, express_1.Router)();
exports.leaderboardRouter.get('/', async (req, res) => {
    try {
        const chainId = parseInt(req.query.chainId || process.env.CHAIN_ID || '99917', 10);
        const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
        const leaderboard = await (0, reputationClient_1.getLeaderboard)(chainId, limit);
        // Enrich with intent counts from Bus DB
        const enriched = await Promise.all(leaderboard.map(async (entry) => {
            const { total } = await (0, busClient_1.getIntents)({
                address: entry.address,
                chainId,
                limit: 1,
            });
            return {
                ...entry,
                totalIntentsOnChain: total,
            };
        }));
        res.json({
            success: true,
            data: enriched,
            meta: {
                count: enriched.length,
                chainId,
                generatedAt: Date.now(),
            },
        });
    }
    catch (err) {
        console.error('[EXPLORER] Leaderboard error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
//# sourceMappingURL=leaderboard.js.map