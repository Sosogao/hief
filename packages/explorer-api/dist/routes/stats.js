"use strict";
/**
 * GET /v1/explorer/stats
 * System-wide statistics: intent counts, status breakdown, active addresses, etc.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.statsRouter = void 0;
const express_1 = require("express");
const busClient_1 = require("../services/busClient");
const reputationClient_1 = require("../services/reputationClient");
exports.statsRouter = (0, express_1.Router)();
exports.statsRouter.get('/', async (_req, res) => {
    try {
        const chainId = parseInt(process.env.CHAIN_ID || '99917', 10);
        const [busStats, leaderboard, repHealthy] = await Promise.all([
            (0, busClient_1.getBusStats)(),
            (0, reputationClient_1.getLeaderboard)(chainId, 5),
            (0, reputationClient_1.checkReputationHealth)(),
        ]);
        const successCount = busStats.byStatus['EXECUTED'] ?? 0;
        const failedCount = busStats.byStatus['FAILED'] ?? 0;
        const totalFinished = successCount + failedCount;
        const successRate = totalFinished > 0 ? successCount / totalFinished : null;
        res.json({
            success: true,
            data: {
                intents: {
                    total: busStats.totalIntents,
                    byStatus: busStats.byStatus,
                    successRate,
                },
                solutions: {
                    total: busStats.totalSolutions,
                },
                addresses: {
                    unique: busStats.uniqueAddresses,
                },
                topAddresses: leaderboard.slice(0, 5),
                recentActivity: busStats.recentActivity,
                services: {
                    bus: true,
                    reputation: repHealthy,
                },
                chainId,
                generatedAt: Date.now(),
            },
        });
    }
    catch (err) {
        console.error('[EXPLORER] Stats error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
//# sourceMappingURL=stats.js.map