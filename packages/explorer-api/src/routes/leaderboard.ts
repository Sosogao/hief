/**
 * Leaderboard routes for Explorer API.
 *
 * GET /v1/explorer/leaderboard  — top addresses by reputation score
 */

import { Router, Request, Response } from 'express';
import { getLeaderboard } from '../services/reputationClient';
import { getIntents } from '../services/busClient';

export const leaderboardRouter = Router();

leaderboardRouter.get('/', async (req: Request, res: Response) => {
  try {
    const chainId = parseInt(req.query.chainId as string || process.env.CHAIN_ID || '99917', 10);
    const limit = Math.min(50, parseInt(req.query.limit as string || '20', 10));

    const leaderboard = await getLeaderboard(chainId, limit);

    // Enrich with intent counts from Bus DB
    const enriched = await Promise.all(
      leaderboard.map(async (entry) => {
        const { total } = await getIntents({
          address: entry.address,
          chainId,
          limit: 1,
        });
        return {
          ...entry,
          totalIntentsOnChain: total,
        };
      })
    );

    res.json({
      success: true,
      data: enriched,
      meta: {
        count: enriched.length,
        chainId,
        generatedAt: Date.now(),
      },
    });
  } catch (err: any) {
    console.error('[EXPLORER] Leaderboard error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
