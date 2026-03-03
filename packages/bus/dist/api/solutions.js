"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.solutionsRouter = void 0;
const express_1 = require("express");
const common_1 = require("@hief/common");
const database_1 = require("../db/database");
exports.solutionsRouter = (0, express_1.Router)();
// POST /solutions - Solver submits a solution
exports.solutionsRouter.post('/', (req, res) => {
    const solution = req.body;
    const { valid, errors } = (0, common_1.validateSolution)(solution);
    if (!valid) {
        return res.status(400).json({
            errorCode: 'INVALID_SOLUTION_SCHEMA',
            message: `Solution schema validation failed: ${errors.join('; ')}`,
        });
    }
    const db = (0, database_1.getDb)();
    const intentRow = (0, database_1.dbGet)(db, 'SELECT id, intent_hash, status FROM intents WHERE id = ?', [solution.intentId]);
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
    const solutionHash = (0, common_1.computeSolutionHash)(solution);
    const existing = (0, database_1.dbGet)(db, 'SELECT id FROM solutions WHERE solution_hash = ?', [solutionHash]);
    if (existing) {
        return res.status(409).json({ errorCode: 'SOLUTION_ALREADY_EXISTS', message: `Solution with hash ${solutionHash} already exists` });
    }
    (0, database_1.dbRun)(db, `INSERT INTO solutions (id, solution_hash, intent_id, intent_hash, solver_id, expected_out, fee, valid_until, status, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?)`, [
        solution.solutionId, solutionHash, solution.intentId, solution.intentHash,
        solution.solverId, solution.quote.expectedOut, solution.quote.fee,
        solution.quote.validUntil, JSON.stringify(solution)
    ]);
    return res.status(200).json({ solutionId: solution.solutionId, status: 'SUBMITTED' });
});
// GET /intents/:intentId/solutions - List solutions for an intent
exports.solutionsRouter.get('/intents/:intentId/solutions', (req, res) => {
    const { intentId } = req.params;
    const { status, limit = '20' } = req.query;
    const db = (0, database_1.getDb)();
    const intentRow = (0, database_1.dbGet)(db, 'SELECT id FROM intents WHERE id = ?', [intentId]);
    if (!intentRow) {
        return res.status(404).json({ errorCode: 'INTENT_NOT_FOUND', message: `Intent ${intentId} not found` });
    }
    const now = Math.floor(Date.now() / 1000);
    let query = `SELECT id, solver_id, expected_out, fee, valid_until, status FROM solutions WHERE intent_id = ? AND valid_until > ?`;
    const params = [intentId, now];
    if (status) {
        query += ' AND status = ?';
        params.push(status);
    }
    query += ' ORDER BY CAST(expected_out AS INTEGER) DESC LIMIT ?';
    params.push(parseInt(limit, 10));
    const rows = (0, database_1.dbAll)(db, query, params);
    const solutions = rows.map((r) => ({
        solutionId: r.id,
        solverId: r.solver_id,
        expectedOut: r.expected_out,
        fee: r.fee,
        validUntil: r.valid_until,
        status: r.status,
    }));
    const response = { intentId, solutions };
    return res.json(response);
});
//# sourceMappingURL=solutions.js.map