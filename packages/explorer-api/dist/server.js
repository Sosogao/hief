"use strict";
/**
 * HIEF Intent Explorer Backend API
 *
 * Aggregates data from:
 * - Intent Bus (SQLite DB): intent history, solutions, policy results
 * - Reputation API (HTTP): scores, leaderboard, behavior tags
 *
 * Exposes a unified REST API for the Explorer frontend.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const stats_1 = require("./routes/stats");
const intents_1 = require("./routes/intents");
const address_1 = require("./routes/address");
const activity_1 = require("./routes/activity");
const leaderboard_1 = require("./routes/leaderboard");
const app = (0, express_1.default)();
exports.app = app;
const PORT = parseInt(process.env.EXPLORER_API_PORT || process.env.PORT || '3006', 10);
// ─── Middleware ───────────────────────────────────────────────────────────────
app.use((0, cors_1.default)({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express_1.default.json({ limit: '1mb' }));
app.use((req, _res, next) => {
    console.log(`[EXPLORER-API] ${req.method} ${req.path}`);
    next();
});
// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'hief-explorer-api',
        version: '0.1.0',
        chainId: parseInt(process.env.CHAIN_ID || '99917', 10),
        uptime: process.uptime(),
    });
});
// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/v1/explorer/stats', stats_1.statsRouter);
app.use('/v1/explorer/intents', intents_1.intentsRouter);
app.use('/v1/explorer/address', address_1.addressRouter);
app.use('/v1/explorer/activity', activity_1.activityRouter);
app.use('/v1/explorer/leaderboard', leaderboard_1.leaderboardRouter);
// ─── Reputation proxy (for backward compat with existing frontend) ────────────
// Forward /v1/reputation/* to the Reputation API
const axios_1 = __importDefault(require("axios"));
const REP_URL = process.env.REPUTATION_API_URL || 'http://localhost:3005';
app.get('/v1/reputation/*', async (req, res) => {
    try {
        const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        const targetUrl = `${REP_URL}${req.path}${queryString}`;
        const upstream = await axios_1.default.get(targetUrl, { timeout: 5000 });
        res.json(upstream.data);
    }
    catch (err) {
        res.status(502).json({ success: false, error: 'Reputation API unavailable' });
    }
});
// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error('[EXPLORER-API] Unhandled error:', err);
    res.status(500).json({ success: false, error: err.message });
});
// ─── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`[EXPLORER-API] HIEF Explorer API running on port ${PORT}`);
        console.log(`[EXPLORER-API] Chain ID: ${process.env.CHAIN_ID || '99917'}`);
        console.log(`[EXPLORER-API] Reputation API: ${REP_URL}`);
        console.log(`[EXPLORER-API] Bus DB: ${process.env.BUS_DB_PATH || '../../packages/bus/data/hief.db'}`);
    });
}
//# sourceMappingURL=server.js.map