/**
 * Address routes for Explorer API.
 *
 * GET /v1/explorer/address/:address  — combined reputation + intent history view
 */

import { Router, Request, Response } from 'express';
import { getIntents } from '../services/busClient';
import { getReputation, getReputationHistory } from '../services/reputationClient';

export const addressRouter = Router();

addressRouter.get('/:address', async (req: Request, res: Response) => {
  const { address } = req.params;

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ success: false, error: 'Invalid Ethereum address' });
  }

  const chainId = parseInt(req.query.chainId as string || process.env.CHAIN_ID || '99917', 10);
  const intentLimit = Math.min(50, parseInt(req.query.intentLimit as string || '10', 10));

  try {
    // Fetch reputation snapshot, intent history, and on-chain intents in parallel
    const [reputation, repHistory, { intents, total }] = await Promise.all([
      getReputation(address.toLowerCase(), chainId),
      getReputationHistory(address.toLowerCase(), chainId, 20),
      getIntents({ address: address.toLowerCase(), chainId, limit: intentLimit }),
    ]);

    // Parse intent data
    const intentSummaries = intents.map((row) => {
      let parsed: any = {};
      try { parsed = JSON.parse(row.data); } catch {}
      return {
        intentId: row.id,
        status: row.status,
        createdAt: row.created_at,
        intentType: parsed.meta?.tags?.[0] ?? 'SWAP',
        userIntentText: parsed.meta?.userIntentText,
        inputToken: parsed.input?.token,
        inputAmount: parsed.input?.amount,
        outputToken: parsed.outputs?.[0]?.token,
        uiHints: parsed.meta?.uiHints,
      };
    });

    // Compute address-level stats from intent list
    const statusCounts: Record<string, number> = {};
    for (const intent of intentSummaries) {
      statusCounts[intent.status] = (statusCounts[intent.status] || 0) + 1;
    }

    return res.json({
      success: true,
      data: {
        address: address.toLowerCase(),
        chainId,
        reputation: reputation ?? null,
        reputationHistory: repHistory,
        intents: {
          total,
          recent: intentSummaries,
          byStatus: statusCounts,
        },
        generatedAt: Date.now(),
      },
    });
  } catch (err: any) {
    console.error('[EXPLORER] Address view error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});
