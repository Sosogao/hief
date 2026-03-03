import { Router, Request, Response } from 'express';
import { computeSolutionHash, validateSolution } from '@hief/common';
import type { HIEFSolution, ListSolutionsResponse, SolutionSummary } from '@hief/common';
import { getDb, dbGet, dbRun, dbAll } from '../db/database';

export const solutionsRouter = Router();

// POST /solutions - Solver submits a solution
solutionsRouter.post('/', (req: Request, res: Response) => {
  const solution = req.body as HIEFSolution;

  const { valid, errors } = validateSolution(solution);
  if (!valid) {
    return res.status(400).json({
      errorCode: 'INVALID_SOLUTION_SCHEMA',
      message: `Solution schema validation failed: ${errors.join('; ')}`,
    });
  }

  const db = getDb();

  const intentRow = dbGet<{ id: string; intent_hash: string; status: string }>(
    db, 'SELECT id, intent_hash, status FROM intents WHERE id = ?', [solution.intentId]
  );

  if (!intentRow) {
    return res.status(404).json({ errorCode: 'INTENT_NOT_FOUND', message: `Intent ${solution.intentId} not found` });
  }

  if (intentRow.intent_hash !== solution.intentHash) {
    return res.status(400).json({ errorCode: 'INTENT_HASH_MISMATCH', message: `solution.intentHash does not match stored intentHash` });
  }

  const now = Math.floor(Date.now() / 1000);
  if (solution.quote.validUntil <= now) {
    return res.status(400).json({ errorCode: 'SOLUTION_QUOTE_EXPIRED', message: 'Solution quote has already expired' });
  }

  const solutionHash = computeSolutionHash(solution);
  const existing = dbGet(db, 'SELECT id FROM solutions WHERE solution_hash = ?', [solutionHash]);
  if (existing) {
    return res.status(409).json({ errorCode: 'SOLUTION_ALREADY_EXISTS', message: `Solution with hash ${solutionHash} already exists` });
  }

  dbRun(db,
    `INSERT INTO solutions (id, solution_hash, intent_id, intent_hash, solver_id, expected_out, fee, valid_until, status, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?)`,
    [
      solution.solutionId, solutionHash, solution.intentId, solution.intentHash,
      solution.solverId, solution.quote.expectedOut, solution.quote.fee,
      solution.quote.validUntil, JSON.stringify(solution)
    ]
  );

  return res.status(200).json({ solutionId: solution.solutionId, status: 'SUBMITTED' });
});

// GET /intents/:intentId/solutions - List solutions for an intent
solutionsRouter.get('/intents/:intentId/solutions', (req: Request, res: Response) => {
  const { intentId } = req.params;
  const { status, limit = '20' } = req.query;

  const db = getDb();
  const intentRow = dbGet(db, 'SELECT id FROM intents WHERE id = ?', [intentId]);
  if (!intentRow) {
    return res.status(404).json({ errorCode: 'INTENT_NOT_FOUND', message: `Intent ${intentId} not found` });
  }

  const now = Math.floor(Date.now() / 1000);
  let query = `SELECT id, solver_id, expected_out, fee, valid_until, status FROM solutions WHERE intent_id = ? AND valid_until > ?`;
  const params: (string | number | null)[] = [intentId, now];

  if (status) {
    query += ' AND status = ?';
    params.push(status as string);
  }
  query += ' ORDER BY CAST(expected_out AS INTEGER) DESC LIMIT ?';
  params.push(parseInt(limit as string, 10));

  const rows = dbAll<{ id: string; solver_id: string; expected_out: string; fee: string; valid_until: number; status: string }>(db, query, params);

  const solutions: SolutionSummary[] = rows.map((r) => ({
    solutionId: r.id,
    solverId: r.solver_id,
    expectedOut: r.expected_out,
    fee: r.fee,
    validUntil: r.valid_until,
    status: r.status as any,
  }));

  const response: ListSolutionsResponse = { intentId, solutions };
  return res.json(response);
});
