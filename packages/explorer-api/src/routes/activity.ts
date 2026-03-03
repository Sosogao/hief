/**
 * Activity routes for Explorer API.
 *
 * GET /v1/explorer/activity  — recent activity feed (last N intents with status)
 */

import { Router, Request, Response } from 'express';
import { getIntents } from '../services/busClient';

export const activityRouter = Router();

activityRouter.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit as string || '20', 10));
    const chainId = req.query.chainId ? parseInt(req.query.chainId as string, 10) : undefined;

    const { intents } = await getIntents({ limit, chainId });

    const feed = intents.map((row) => {
      let parsed: any = {};
      try { parsed = JSON.parse(row.data); } catch {}

      const inputSymbol = parsed.meta?.uiHints?.inputTokenSymbol ?? 'TOKEN';
      const outputSymbol = parsed.meta?.uiHints?.outputTokenSymbol ?? 'TOKEN';
      const inputAmountHuman = parsed.meta?.uiHints?.inputAmountHuman ?? '?';
      const intentType = parsed.meta?.tags?.[0] ?? 'SWAP';

      // Build human-readable description
      let description = parsed.meta?.userIntentText ?? `${intentType} ${inputAmountHuman} ${inputSymbol} → ${outputSymbol}`;

      return {
        intentId: row.id,
        intentHash: row.intent_hash,
        smartAccount: row.smart_account,
        chainId: row.chain_id,
        status: row.status,
        intentType,
        description,
        inputToken: inputSymbol,
        outputToken: outputSymbol,
        inputAmount: inputAmountHuman,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // Relative time
        ageSeconds: Math.floor(Date.now() / 1000) - row.created_at,
      };
    });

    res.json({
      success: true,
      data: feed,
      meta: {
        count: feed.length,
        generatedAt: Date.now(),
      },
    });
  } catch (err: any) {
    console.error('[EXPLORER] Activity error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
