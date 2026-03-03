"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.server = exports.app = void 0;
const express_1 = __importDefault(require("express"));
const policyEngine_1 = require("./engine/policyEngine");
const app = (0, express_1.default)();
exports.app = app;
const PORT = process.env.PORT || 3002;
app.use(express_1.default.json({ limit: '1mb' }));
app.use((req, _res, next) => {
    console.log(`[POLICY] ${req.method} ${req.path}`);
    next();
});
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'hief-policy', version: '0.1.0' });
});
// POST /v1/policy/validateSolution - Full validation (static + simulation)
app.post('/v1/policy/validateSolution', async (req, res) => {
    const { intent, solution } = req.body;
    if (!intent || !solution) {
        return res.status(400).json({ errorCode: 'MISSING_FIELDS', message: 'intent and solution are required' });
    }
    try {
        const result = await (0, policyEngine_1.validateSolution)(intent, solution);
        return res.json(result);
    }
    catch (err) {
        console.error('[POLICY] Validation error:', err);
        return res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: err.message });
    }
});
// POST /v1/policy/validateIntent - Lightweight intent pre-validation
app.post('/v1/policy/validateIntent', async (req, res) => {
    const { intent } = req.body;
    if (!intent) {
        return res.status(400).json({ errorCode: 'MISSING_FIELDS', message: 'intent is required' });
    }
    try {
        const result = await (0, policyEngine_1.validateIntent)(intent);
        return res.json(result);
    }
    catch (err) {
        console.error('[POLICY] Intent validation error:', err);
        return res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: err.message });
    }
});
app.use((err, _req, res, _next) => {
    console.error('[POLICY] Unhandled error:', err);
    res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: err.message });
});
const server = app.listen(PORT, () => {
    console.log(`[POLICY] HIEF Policy Engine running on port ${PORT}`);
});
exports.server = server;
//# sourceMappingURL=server.js.map