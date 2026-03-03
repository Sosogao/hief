import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { computePlanHash } from '@hief/common';
import type { HIEFIntent, HIEFSolution, HIEFPolicyResult } from '@hief/common';
import { getDb, dbGet, dbRun } from '../db/database';
import { callPolicyEngine } from '../orchestration/policyClient';
import { createSafeProposal } from '../orchestration/safeClient';

export const proposalsRouter = Router();

// POST /intents/:intentId/proposals - Create a Safe proposal
proposalsRouter.post('/:intentId/proposals', async (req: Request, res: Response) => {
  const { intentId } = req.params;
  const { solutionId, safeAddress, chainId } = req.body;

  if (!solutionId || !safeAddress || !chainId) {
    return res.status(400).json({ errorCode: 'MISSING_REQUIRED_FIELDS', message: 'solutionId, safeAddress, and chainId are required' });
  }

  const db = getDb();

  const intentRow = dbGet<{ data: string; intent_hash: string; status: string }>(
    db, 'SELECT data, intent_hash, status FROM intents WHERE id = ?', [intentId]
  );
  if (!intentRow) {
    return res.status(404).json({ errorCode: 'INTENT_NOT_FOUND', message: `Intent ${intentId} not found` });
  }

  const solutionRow = dbGet<{ data: string; status: string }>(
    db, 'SELECT data, status FROM solutions WHERE id = ? AND intent_id = ?', [solutionId, intentId]
  );
  if (!solutionRow) {
    return res.status(404).json({ errorCode: 'SOLUTION_NOT_FOUND', message: `Solution ${solutionId} not found` });
  }

  const intent: HIEFIntent = JSON.parse(intentRow.data);
  const solution: HIEFSolution = JSON.parse(solutionRow.data);

  dbRun(db, "UPDATE intents SET status = 'VALIDATING', updated_at = strftime('%s','now') WHERE id = ?", [intentId]);

  let policyResult: HIEFPolicyResult;
  try {
    policyResult = await callPolicyEngine(intent, solution);
  } catch (err: any) {
    dbRun(db, "UPDATE intents SET status = 'FAILED', updated_at = strftime('%s','now') WHERE id = ?", [intentId]);
    return res.status(502).json({ errorCode: 'POLICY_ENGINE_ERROR', message: `Policy engine call failed: ${err.message}` });
  }

  const policyResultId = uuidv4();
  dbRun(db,
    `INSERT INTO policy_results (id, intent_hash, solution_id, solution_hash, status, summary, findings, execution_diff, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      policyResultId, intentRow.intent_hash, solutionId, solution.solutionId,
      policyResult.status, JSON.stringify(policyResult.summary),
      JSON.stringify(policyResult.findings),
      policyResult.executionDiff ? JSON.stringify(policyResult.executionDiff) : null,
      JSON.stringify(policyResult)
    ]
  );

  if (policyResult.status === 'FAIL') {
    dbRun(db, "UPDATE intents SET status = 'FAILED', updated_at = strftime('%s','now') WHERE id = ?", [intentId]);
    dbRun(db, "UPDATE solutions SET status = 'REJECTED', updated_at = strftime('%s','now') WHERE id = ?", [solutionId]);
    return res.status(422).json({
      errorCode: 'POLICY_VALIDATION_FAILED',
      message: 'Policy engine rejected the solution',
      policyStatus: policyResult.status,
      findings: policyResult.findings,
      summary: policyResult.summary,
    });
  }

  const planHash = computePlanHash(solution, intentRow.intent_hash);
  dbRun(db, "UPDATE intents SET status = 'PROPOSING', updated_at = strftime('%s','now') WHERE id = ?", [intentId]);

  let safeTxHash: string | undefined;
  try {
    safeTxHash = await createSafeProposal(intent, solution, policyResult, planHash, safeAddress, chainId);
  } catch (err: any) {
    console.error('[BUS] Safe proposal creation failed:', err.message);
  }

  const proposalId = uuidv4();
  dbRun(db,
    `INSERT INTO proposals (id, intent_id, solution_id, plan_hash, safe_address, safe_tx_hash, status, human_summary, data)
     VALUES (?, ?, ?, ?, ?, ?, 'PROPOSED_TO_SAFE', ?, ?)`,
    [
      proposalId, intentId, solutionId, planHash, safeAddress,
      safeTxHash ?? null, JSON.stringify(policyResult.summary),
      JSON.stringify({ intentId, solutionId, planHash, policyResultId, safeTxHash })
    ]
  );

  return res.status(200).json({
    proposalId,
    status: 'PROPOSED_TO_SAFE',
    safeTxHash: safeTxHash ?? null,
    humanSummary: policyResult.summary,
    planHash,
    policyStatus: policyResult.status,
  });
});

// GET /intents/:intentId/policy - Get policy result for an intent
proposalsRouter.get('/:intentId/policy', (req: Request, res: Response) => {
  const { intentId } = req.params;
  const { solutionId } = req.query;

  const db = getDb();
  const intentRow = dbGet<{ intent_hash: string }>(db, 'SELECT intent_hash FROM intents WHERE id = ?', [intentId]);
  if (!intentRow) {
    return res.status(404).json({ errorCode: 'INTENT_NOT_FOUND', message: `Intent ${intentId} not found` });
  }

  let query = 'SELECT data FROM policy_results WHERE intent_hash = ?';
  const params: (string | number | null)[] = [intentRow.intent_hash];
  if (solutionId) {
    query += ' AND solution_id = ?';
    params.push(solutionId as string);
  }
  query += ' ORDER BY created_at DESC LIMIT 1';

  const row = dbGet<{ data: string }>(db, query, params);
  if (!row) {
    return res.status(404).json({ errorCode: 'POLICY_RESULT_NOT_FOUND', message: 'No policy result found' });
  }

  return res.json(JSON.parse(row.data));
});
