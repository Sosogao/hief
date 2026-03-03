"use strict";
/**
 * Activity routes for Explorer API.
 *
 * GET /v1/explorer/activity  — recent activity feed (last N intents with status)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.activityRouter = void 0;
const express_1 = require("express");
const busClient_1 = require("../services/busClient");
exports.activityRouter = (0, express_1.Router)();
exports.activityRouter.get('/', async (req, res) => {
    try {
        const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
        const chainId = req.query.chainId ? parseInt(req.query.chainId, 10) : undefined;
        const { intents } = await (0, busClient_1.getIntents)({ limit, chainId });
        const feed = intents.map((row) => {
            let parsed = {};
            try {
                parsed = JSON.parse(row.data);
            }
            catch { }
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
    }
    catch (err) {
        console.error('[EXPLORER] Activity error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
//# sourceMappingURL=activity.js.map