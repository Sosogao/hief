import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  computeIntentHash,
  validateIntent,
  QUOTE_WINDOW_MS,
} from '@hief/common';
import type { HIEFIntent, SubmitIntentResponse } from '@hief/common';
import { getDb, dbGet, dbRun, dbAll } from '../db/database';
import { canTransitionIntent, isTerminalIntentStatus } from '../state/intentStateMachine';
import { broadcastToSolvers } from '../broadcast/solverBroadcast';

export const intentsRouter = Router();

// POST /intents - Submit a new Intent
intentsRouter.post('/', async (req: Request, res: Response) => {
  const intent = req.body as HIEFIntent;

  // 1. Schema validation
  const { valid, errors } = validateIntent(intent);
  if (!valid) {
    return res.status(400).json({
      errorCode: 'INVALID_INTENT_SCHEMA',
      message: `Intent schema validation failed: ${errors.join('; ')}`,
    });
  }

  // 2. Deadline check
  const now = Math.floor(Date.now() / 1000);
  if (intent.deadline <= now + 60) {
    return res.status(400).json({
      errorCode: 'INTENT_DEADLINE_TOO_SOON',
      message: 'Intent deadline must be at least 60 seconds in the future',
    });
  }

  // 3. Compute intentHash
  const intentHash = computeIntentHash(intent);

  // 4. Check for duplicate
  const db = getDb();
  const existing = dbGet(db, 'SELECT id FROM intents WHERE intent_hash = ?', [intentHash]);
  if (existing) {
    return res.status(409).json({
      errorCode: 'INTENT_ALREADY_EXISTS',
      message: `Intent with hash ${intentHash} already exists`,
    });
  }

  // 5. Persist
  const intentId = intent.intentId || uuidv4();
  dbRun(db,
    `INSERT INTO intents (id, intent_hash, smart_account, chain_id, deadline, status, data)
     VALUES (?, ?, ?, ?, ?, 'BROADCAST', ?)`,
    [intentId, intentHash, intent.smartAccount, intent.chainId, intent.deadline, JSON.stringify({ ...intent, intentId })]
  );

  // 6. Broadcast to solvers (async, non-blocking)
  broadcastToSolvers(intentId, intentHash, intent).catch((err) => {
    console.error('[BUS] Failed to broadcast intent:', err.message);
  });

  const response: SubmitIntentResponse = {
    intentId,
    intentHash,
    status: 'BROADCAST',
    quoteWindowMs: QUOTE_WINDOW_MS,
  };

  return res.status(200).json(response);
});

// GET /intents/:intentId - Get intent details
intentsRouter.get('/:intentId', (req: Request, res: Response) => {
  const { intentId } = req.params;
  const db = getDb();
  const row = dbGet<{ data: string; status: string }>(
    db, 'SELECT data, status FROM intents WHERE id = ?', [intentId]
  );

  if (!row) {
    return res.status(404).json({
      errorCode: 'INTENT_NOT_FOUND',
      message: `Intent ${intentId} not found`,
    });
  }

  const intent = JSON.parse(row.data);
  return res.json({ ...intent, _status: row.status });
});

// POST /intents/:intentId/cancel - Cancel an intent
intentsRouter.post('/:intentId/cancel', (req: Request, res: Response) => {
  const { intentId } = req.params;
  const db = getDb();
  const row = dbGet<{ status: string }>(db, 'SELECT status FROM intents WHERE id = ?', [intentId]);

  if (!row) {
    return res.status(404).json({ errorCode: 'INTENT_NOT_FOUND', message: `Intent ${intentId} not found` });
  }

  if (isTerminalIntentStatus(row.status as any)) {
    return res.status(400).json({ errorCode: 'INTENT_ALREADY_TERMINAL', message: `Intent is already in terminal state: ${row.status}` });
  }

  if (!canTransitionIntent(row.status as any, 'CANCELLED')) {
    return res.status(400).json({ errorCode: 'INVALID_STATE_TRANSITION', message: `Cannot cancel intent in state: ${row.status}` });
  }

  dbRun(db, "UPDATE intents SET status = 'CANCELLED', updated_at = strftime('%s','now') WHERE id = ?", [intentId]);
  return res.json({ intentId, status: 'CANCELLED' });
});

// POST /intents/:intentId/select - Select a solution
intentsRouter.post('/:intentId/select', async (req: Request, res: Response) => {
  const { intentId } = req.params;
  const { solutionId } = req.body;

  if (!solutionId) {
    return res.status(400).json({ errorCode: 'MISSING_SOLUTION_ID', message: 'solutionId is required' });
  }

  const db = getDb();
  const intentRow = dbGet<{ status: string }>(db, 'SELECT status FROM intents WHERE id = ?', [intentId]);
  if (!intentRow) {
    return res.status(404).json({ errorCode: 'INTENT_NOT_FOUND', message: `Intent ${intentId} not found` });
  }

  const solutionRow = dbGet<{ id: string; intent_id: string; status: string }>(
    db, 'SELECT id, intent_id, status FROM solutions WHERE id = ?', [solutionId]
  );

  if (!solutionRow || solutionRow.intent_id !== intentId) {
    return res.status(404).json({ errorCode: 'SOLUTION_NOT_FOUND', message: `Solution ${solutionId} not found for intent ${intentId}` });
  }

  if (solutionRow.status === 'EXPIRED') {
    return res.status(400).json({ errorCode: 'SOLUTION_EXPIRED', message: 'Selected solution has expired' });
  }

  dbRun(db, "UPDATE intents SET status = 'SELECTED', updated_at = strftime('%s','now') WHERE id = ?", [intentId]);
  dbRun(db, "UPDATE solutions SET status = 'SELECTED', updated_at = strftime('%s','now') WHERE id = ?", [solutionId]);

  return res.json({ intentId, selectedSolutionId: solutionId, status: 'SELECTED' });
});
