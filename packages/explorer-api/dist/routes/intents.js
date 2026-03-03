"use strict";
/**
 * Intent routes for Explorer API.
 *
 * GET /v1/explorer/intents          — paginated list with filters
 * GET /v1/explorer/intents/:id      — intent detail with solutions + policy result
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.intentsRouter = void 0;
const express_1 = require("express");
const busClient_1 = require("../services/busClient");
exports.intentsRouter = (0, express_1.Router)();
// ─── List Intents ─────────────────────────────────────────────────────────────
exports.intentsRouter.get('/', async (req, res) => {
    try {
        const limit = Math.min(100, parseInt(req.query.limit || '20', 10));
        const offset = parseInt(req.query.offset || '0', 10);
        const status = req.query.status;
        const address = req.query.address;
        const chainId = req.query.chainId ? parseInt(req.query.chainId, 10) : undefined;
        const { intents, total } = await (0, busClient_1.getIntents)({ limit, offset, status, address, chainId });
        // Parse the JSON data field and enrich each intent
        const enriched = intents.map((row) => {
            let parsed = {};
            try {
                parsed = JSON.parse(row.data);
            }
            catch { }
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
    }
    catch (err) {
        console.error('[EXPLORER] Intents list error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
// ─── Intent Detail ────────────────────────────────────────────────────────────
exports.intentsRouter.get('/:intentId', async (req, res) => {
    try {
        const { intentId } = req.params;
        const row = await (0, busClient_1.getIntentById)(intentId);
        if (!row) {
            return res.status(404).json({ success: false, error: `Intent ${intentId} not found` });
        }
        let intentData = {};
        try {
            intentData = JSON.parse(row.data);
        }
        catch { }
        // Fetch related solutions and policy result in parallel
        const [solutions, policyResult] = await Promise.all([
            (0, busClient_1.getSolutionsForIntent)(intentId),
            (0, busClient_1.getPolicyResultForIntent)(row.intent_hash),
        ]);
        const parsedSolutions = solutions.map((s) => {
            let sData = {};
            try {
                sData = JSON.parse(s.data);
            }
            catch { }
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
        let parsedPolicy = null;
        if (policyResult) {
            try {
                parsedPolicy = {
                    status: policyResult.status,
                    summary: JSON.parse(policyResult.summary || '[]'),
                    findings: JSON.parse(policyResult.findings || '[]'),
                    createdAt: policyResult.created_at,
                };
            }
            catch {
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
            },
        });
    }
    catch (err) {
        console.error('[EXPLORER] Intent detail error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
//# sourceMappingURL=intents.js.map