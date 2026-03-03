/**
 * GET /v1/explorer/stats
 * System-wide statistics: intent counts, status breakdown, active addresses, etc.
 */

import { Router, Request, Response } from 'express';
import { getBusStats } from '../services/busClient';
import { getLeaderboard, checkReputationHealth } from '../services/reputationClient';

export const statsRouter = Router();

statsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const chainId = parseInt(process.env.CHAIN_ID || '99917', 10);

    const [busStats, leaderboard, repHealthy] = await Promise.all([
      getBusStats(),
      getLeaderboard(chainId, 5),
      checkReputationHealth(),
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
  } catch (err: any) {
    console.error('[EXPLORER] Stats error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
