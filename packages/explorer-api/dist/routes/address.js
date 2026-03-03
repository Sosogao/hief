"use strict";
/**
 * Address routes for Explorer API.
 *
 * GET /v1/explorer/address/:address  — combined reputation + intent history view
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.addressRouter = void 0;
const express_1 = require("express");
const busClient_1 = require("../services/busClient");
const reputationClient_1 = require("../services/reputationClient");
exports.addressRouter = (0, express_1.Router)();
exports.addressRouter.get('/:address', async (req, res) => {
    const { address } = req.params;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return res.status(400).json({ success: false, error: 'Invalid Ethereum address' });
    }
    const chainId = parseInt(req.query.chainId || process.env.CHAIN_ID || '99917', 10);
    const intentLimit = Math.min(50, parseInt(req.query.intentLimit || '10', 10));
    try {
        // Fetch reputation snapshot, intent history, and on-chain intents in parallel
        const [reputation, repHistory, { intents, total }] = await Promise.all([
            (0, reputationClient_1.getReputation)(address.toLowerCase(), chainId),
            (0, reputationClient_1.getReputationHistory)(address.toLowerCase(), chainId, 20),
            (0, busClient_1.getIntents)({ address: address.toLowerCase(), chainId, limit: intentLimit }),
        ]);
        // Parse intent data
        const intentSummaries = intents.map((row) => {
            let parsed = {};
            try {
                parsed = JSON.parse(row.data);
            }
            catch { }
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
        const statusCounts = {};
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
    }
    catch (err) {
        console.error('[EXPLORER] Address view error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});
//# sourceMappingURL=address.js.map