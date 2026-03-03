/**
 * Intent routes for Explorer API.
 *
 * GET /v1/explorer/intents          — paginated list with filters
 * GET /v1/explorer/intents/:id      — intent detail with solutions + policy result
 */

import { Router, Request, Response } from 'express';
import {
  getIntents,
  getIntentById,
  getSolutionsForIntent,
  getPolicyResultForIntent,
} from '../services/busClient';

export const intentsRouter = Router();

// ─── List Intents ─────────────────────────────────────────────────────────────

intentsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit as string || '20', 10));
    const offset = parseInt(req.query.offset as string || '0', 10);
    const status = req.query.status as string | undefined;
    const address = req.query.address as string | undefined;
    const chainId = req.query.chainId ? parseInt(req.query.chainId as string, 10) : undefined;

    const { intents, total } = await getIntents({ limit, offset, status, address, chainId });

    // Parse the JSON data field and enrich each intent
    const enriched = intents.map((row) => {
      let parsed: any = {};
      try { parsed = JSON.parse(row.data); } catch {}
      return {
        intentId: row.id,
        intentHash: row.intent_hash,
        smartAccount: row.smart_account,
        chainId: row.chain_id,
        deadline: row.deadline,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // Enriched from data
        inputToken: parsed.input?.token,
        inputAmount: parsed.input?.amount,
        outputToken: parsed.outputs?.[0]?.token,
        intentType: parsed.meta?.tags?.[0] ?? 'SWAP',
        userIntentText: parsed.meta?.userIntentText,
        uiHints: parsed.meta?.uiHints,
        // Settlement info
        settlementTxHash: parsed._settlementTxHash ?? null,
        settlementStatus: parsed._settlementStatus ?? null,
        settledAt: parsed._settledAt ?? null,
      };
    });

    res.json({
      success: true,
      data: enriched,
      meta: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (err: any) {
    console.error('[EXPLORER] Intents list error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Intent Detail ────────────────────────────────────────────────────────────

intentsRouter.get('/:intentId', async (req: Request, res: Response) => {
  try {
    const { intentId } = req.params;
    const row = await getIntentById(intentId);

    if (!row) {
      return res.status(404).json({ success: false, error: `Intent ${intentId} not found` });
    }

    let intentData: any = {};
    try { intentData = JSON.parse(row.data); } catch {}

    // Fetch related solutions and policy result in parallel
    const [solutions, policyResult] = await Promise.all([
      getSolutionsForIntent(intentId),
      getPolicyResultForIntent(row.intent_hash),
    ]);

    const parsedSolutions = solutions.map((s: any) => {
      let sData: any = {};
      try { sData = JSON.parse(s.data); } catch {}
      return {
        solutionId: s.id,
        solutionHash: s.solution_hash,
        solverId: s.solver_id,
        expectedOut: s.expected_out,
        fee: s.fee,
        validUntil: s.valid_until,
        status: s.status,
        createdAt: s.created_at,
        ...sData,
      };
    });

    let parsedPolicy: any = null;
    if (policyResult) {
      try {
        parsedPolicy = {
          status: policyResult.status,
          summary: JSON.parse(policyResult.summary || '[]'),
          findings: JSON.parse(policyResult.findings || '[]'),
          createdAt: policyResult.created_at,
        };
      } catch {
        parsedPolicy = { status: policyResult.status };
      }
    }

    return res.json({
      success: true,
      data: {
        intentId: row.id,
        intentHash: row.intent_hash,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        intent: intentData,
        solutions: parsedSolutions,
        policyResult: parsedPolicy,
        // Settlement info (populated after on-chain execution)
        settlementTxHash: intentData._settlementTxHash ?? null,
        settlementStatus: intentData._settlementStatus ?? null,
        settledAt: intentData._settledAt ?? null,
      },
    });
  } catch (err: any) {
    console.error('[EXPLORER] Intent detail error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
