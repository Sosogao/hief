"use strict";
/**
 * HIEF Reputation API Server
 *
 * Exposes the Reputation Layer via HTTP endpoints.
 *
 * Endpoints:
 *   GET  /v1/reputation/:chainId/:address          — get snapshot
 *   GET  /v1/reputation/:chainId/:address/history  — intent history
 *   GET  /v1/reputation/:chainId/leaderboard       — top addresses
 *   POST /v1/reputation/events                     — ingest intent event
 *   GET  /v1/reputation/health                     — health check
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
exports.initServer = initServer;
const express_1 = __importDefault(require("express"));
const reputationStore_1 = require("../engine/reputationStore");
const scoringEngine_1 = require("../engine/scoringEngine");
const app = (0, express_1.default)();
exports.app = app;
app.use(express_1.default.json());
// ─── Shared Store ─────────────────────────────────────────────────────────────
let store;
async function initServer() {
    store = new reputationStore_1.ReputationStore(new scoringEngine_1.ScoringEngine());
    await store.init();
    return store;
}
// ─── Middleware ───────────────────────────────────────────────────────────────
function validateAddress(req, res, next) {
    const { address } = req.params;
    if (address && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        res.status(400).json({ error: 'Invalid Ethereum address format' });
        return;
    }
    next();
}
function validateChainId(req, res, next) {
    const chainId = parseInt(req.params.chainId, 10);
    if (isNaN(chainId) || chainId <= 0) {
        res.status(400).json({ error: 'Invalid chainId' });
        return;
    }
    next();
}
// ─── Routes ───────────────────────────────────────────────────────────────────
/**
 * GET /v1/reputation/:chainId/leaderboard
 * Returns top addresses by reputation score.
 * NOTE: Must be registered BEFORE /:address to avoid route conflict.
 */
app.get('/v1/reputation/:chainId/leaderboard', validateChainId, (req, res) => {
    const chainId = parseInt(req.params.chainId, 10);
    const limit = Math.min(50, parseInt(req.query.limit ?? '20', 10));
    const leaderboard = store.getLeaderboard(chainId, limit);
    res.json({
        success: true,
        data: leaderboard,
        meta: { count: leaderboard.length, chainId },
    });
});
/**
 * GET /v1/reputation/:chainId/:address
 * Returns the current reputation snapshot for an address.
 * Used by: Solver (pricing), Skill (strategy), Policy (risk tier)
 */
app.get('/v1/reputation/:chainId/:address', validateChainId, validateAddress, async (req, res) => {
    const chainId = parseInt(req.params.chainId, 10);
    const address = req.params.address.toLowerCase();
    const forceRefresh = req.query.refresh === 'true';
    const { snapshot, cached } = await store.getOrComputeSnapshot(address, chainId, forceRefresh);
    res.json({
        success: true,
        data: snapshot,
        meta: {
            cached,
            source: cached ? 'cache' : 'computed',
            ttlSeconds: Math.floor((snapshot.validUntil - Date.now()) / 1000),
        },
    });
});
/**
 * GET /v1/reputation/:chainId/:address/history
 * Returns paginated intent history for an address.
 */
app.get('/v1/reputation/:chainId/:address/history', validateChainId, validateAddress, (req, res) => {
    const chainId = parseInt(req.params.chainId, 10);
    const address = req.params.address.toLowerCase();
    const limit = Math.min(100, parseInt(req.query.limit ?? '20', 10));
    const history = store.getIntentHistory(address, chainId, limit);
    res.json({
        success: true,
        data: history,
        meta: { count: history.length, limit },
    });
});
// leaderboard route moved above :address route to avoid conflict
/**
 * POST /v1/reputation/events
 * Ingest an intent execution event and update reputation.
 * Called by Intent Bus after each intent resolution.
 */
app.post('/v1/reputation/events', async (req, res) => {
    const payload = req.body;
    // Validate required fields
    if (!payload.intentId || !payload.address || !payload.chainId || !payload.status) {
        res.status(400).json({ error: 'Missing required fields: intentId, address, chainId, status' });
        return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(payload.address)) {
        res.status(400).json({ error: 'Invalid address format' });
        return;
    }
    const snapshot = store.processIntentEvent({
        intentId: payload.intentId,
        address: payload.address.toLowerCase(),
        chainId: payload.chainId,
        intentType: payload.intentType ?? 'SWAP',
        inputToken: payload.inputToken ?? '0x',
        outputToken: payload.outputToken ?? '0x',
        inputAmountUSD: payload.inputAmountUSD ?? 0,
        status: payload.status,
        submittedAt: Date.now(),
        executedAt: payload.executedAt,
        alphaScore: payload.alphaScore,
        skillId: payload.skillId,
        actualSlippageBps: payload.actualSlippageBps,
    });
    res.json({
        success: true,
        data: {
            address: payload.address,
            newScore: snapshot.scores.final,
            riskTier: snapshot.riskTier,
            behaviorTags: snapshot.behaviorTags,
        },
    });
});
/**
 * GET /v1/reputation/health
 */
app.get('/v1/reputation/health', (_req, res) => {
    res.json({ status: 'ok', service: 'hief-reputation', version: '0.1.0' });
});
// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error('[reputation]', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});
// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.REPUTATION_PORT ?? '3005', 10);
if (require.main === module) {
    initServer().then(() => {
        app.listen(PORT, () => {
            console.log(`[reputation] Service running on port ${PORT}`);
        });
    });
}
//# sourceMappingURL=server.js.map