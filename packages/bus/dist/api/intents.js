"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.intentsRouter = void 0;
const express_1 = require("express");
const uuid_1 = require("uuid");
const common_1 = require("@hief/common");
const database_1 = require("../db/database");
const intentStateMachine_1 = require("../state/intentStateMachine");
const solverBroadcast_1 = require("../broadcast/solverBroadcast");
exports.intentsRouter = (0, express_1.Router)();
// POST /intents - Submit a new Intent
exports.intentsRouter.post('/', async (req, res) => {
    const intent = req.body;
    // 1. Schema validation
    const { valid, errors } = (0, common_1.validateIntent)(intent);
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
    const intentHash = (0, common_1.computeIntentHash)(intent);
    // 4. Check for duplicate
    const db = (0, database_1.getDb)();
    const existing = (0, database_1.dbGet)(db, 'SELECT id FROM intents WHERE intent_hash = ?', [intentHash]);
    if (existing) {
        return res.status(409).json({
            errorCode: 'INTENT_ALREADY_EXISTS',
            message: `Intent with hash ${intentHash} already exists`,
        });
    }
    // 5. Persist
    const intentId = intent.intentId || (0, uuid_1.v4)();
    (0, database_1.dbRun)(db, `INSERT INTO intents (id, intent_hash, smart_account, chain_id, deadline, status, data)
     VALUES (?, ?, ?, ?, ?, 'BROADCAST', ?)`, [intentId, intentHash, intent.smartAccount, intent.chainId, intent.deadline, JSON.stringify({ ...intent, intentId })]);
    // 6. Broadcast to solvers (async, non-blocking)
    (0, solverBroadcast_1.broadcastToSolvers)(intentId, intentHash, intent).catch((err) => {
        console.error('[BUS] Failed to broadcast intent:', err.message);
    });
    const response = {
        intentId,
        intentHash,
        status: 'BROADCAST',
        quoteWindowMs: common_1.QUOTE_WINDOW_MS,
    };
    return res.status(200).json(response);
});
// GET /intents/:intentId - Get intent details
exports.intentsRouter.get('/:intentId', (req, res) => {
    const { intentId } = req.params;
    const db = (0, database_1.getDb)();
    const row = (0, database_1.dbGet)(db, 'SELECT data, status FROM intents WHERE id = ?', [intentId]);
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
exports.intentsRouter.post('/:intentId/cancel', (req, res) => {
    const { intentId } = req.params;
    const db = (0, database_1.getDb)();
    const row = (0, database_1.dbGet)(db, 'SELECT status FROM intents WHERE id = ?', [intentId]);
    if (!row) {
        return res.status(404).json({ errorCode: 'INTENT_NOT_FOUND', message: `Intent ${intentId} not found` });
    }
    if ((0, intentStateMachine_1.isTerminalIntentStatus)(row.status)) {
        return res.status(400).json({ errorCode: 'INTENT_ALREADY_TERMINAL', message: `Intent is already in terminal state: ${row.status}` });
    }
    if (!(0, intentStateMachine_1.canTransitionIntent)(row.status, 'CANCELLED')) {
        return res.status(400).json({ errorCode: 'INVALID_STATE_TRANSITION', message: `Cannot cancel intent in state: ${row.status}` });
    }
    (0, database_1.dbRun)(db, "UPDATE intents SET status = 'CANCELLED', updated_at = strftime('%s','now') WHERE id = ?", [intentId]);
    return res.json({ intentId, status: 'CANCELLED' });
});
// POST /intents/:intentId/select - Select a solution
exports.intentsRouter.post('/:intentId/select', async (req, res) => {
    const { intentId } = req.params;
    const { solutionId } = req.body;
    if (!solutionId) {
        return res.status(400).json({ errorCode: 'MISSING_SOLUTION_ID', message: 'solutionId is required' });
    }
    const db = (0, database_1.getDb)();
    const intentRow = (0, database_1.dbGet)(db, 'SELECT status FROM intents WHERE id = ?', [intentId]);
    if (!intentRow) {
        return res.status(404).json({ errorCode: 'INTENT_NOT_FOUND', message: `Intent ${intentId} not found` });
    }
    const solutionRow = (0, database_1.dbGet)(db, 'SELECT id, intent_id, status FROM solutions WHERE id = ?', [solutionId]);
    if (!solutionRow || solutionRow.intent_id !== intentId) {
        return res.status(404).json({ errorCode: 'SOLUTION_NOT_FOUND', message: `Solution ${solutionId} not found for intent ${intentId}` });
    }
    if (solutionRow.status === 'EXPIRED') {
        return res.status(400).json({ errorCode: 'SOLUTION_EXPIRED', message: 'Selected solution has expired' });
    }
    (0, database_1.dbRun)(db, "UPDATE intents SET status = 'SELECTED', updated_at = strftime('%s','now') WHERE id = ?", [intentId]);
    (0, database_1.dbRun)(db, "UPDATE solutions SET status = 'SELECTED', updated_at = strftime('%s','now') WHERE id = ?", [solutionId]);
    return res.json({ intentId, selectedSolutionId: solutionId, status: 'SELECTED' });
});
//# sourceMappingURL=intents.js.map