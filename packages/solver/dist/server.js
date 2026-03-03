"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.server = exports.app = void 0;
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const ethers_1 = require("ethers");
const cowAdapter_1 = require("./adapters/cowAdapter");
const app = (0, express_1.default)();
exports.app = app;
const PORT = process.env.PORT || 3003;
const BUS_URL = process.env.BUS_URL || 'http://localhost:3001';
const SOLVER_ID = process.env.SOLVER_ID || ethers_1.ethers.Wallet.createRandom().address;
app.use(express_1.default.json({ limit: '1mb' }));
app.use((req, _res, next) => {
    console.log(`[SOLVER] ${req.method} ${req.path}`);
    next();
});
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'hief-solver', version: '0.1.0', solverId: SOLVER_ID });
});
/**
 * POST /v1/solver/solve - Receive an intent from the bus and return a solution.
 * This is the endpoint the bus calls when broadcasting intents.
 */
app.post('/v1/solver/solve', async (req, res) => {
    const { intentId, intentHash, intent } = req.body;
    if (!intentId || !intentHash || !intent) {
        return res.status(400).json({ errorCode: 'MISSING_FIELDS', message: 'intentId, intentHash, and intent are required' });
    }
    console.log(`[SOLVER] Received intent ${intentId} for ${intent.input.amount} ${intent.input.token} → ${intent.outputs[0]?.token}`);
    try {
        // Try CoW Protocol first
        const cowQuote = await (0, cowAdapter_1.getCowQuote)(intent);
        if (cowQuote) {
            const solution = (0, cowAdapter_1.buildSolutionFromCowQuote)(intent, cowQuote, SOLVER_ID);
            // Override intentHash with the actual one from the bus
            solution.intentHash = intentHash;
            // Submit solution back to the bus
            try {
                await axios_1.default.post(`${BUS_URL}/v1/solutions`, solution, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10000,
                });
                console.log(`[SOLVER] Solution ${solution.solutionId} submitted for intent ${intentId}`);
                return res.json({ solutionId: solution.solutionId, status: 'SUBMITTED', protocol: 'cow' });
            }
            catch (submitErr) {
                console.error('[SOLVER] Failed to submit solution:', submitErr.message);
                return res.status(502).json({ errorCode: 'BUS_SUBMISSION_FAILED', message: submitErr.message });
            }
        }
        // Fallback: no quote available
        console.log(`[SOLVER] No quote available for intent ${intentId}`);
        return res.status(204).send();
    }
    catch (err) {
        console.error('[SOLVER] Solve error:', err.message);
        return res.status(500).json({ errorCode: 'SOLVER_ERROR', message: err.message });
    }
});
/**
 * POST /v1/solver/quote - Get a quote for an intent without submitting.
 */
app.post('/v1/solver/quote', async (req, res) => {
    const { intent } = req.body;
    if (!intent) {
        return res.status(400).json({ errorCode: 'MISSING_FIELDS', message: 'intent is required' });
    }
    try {
        const cowQuote = await (0, cowAdapter_1.getCowQuote)(intent);
        if (!cowQuote) {
            return res.status(404).json({ errorCode: 'NO_QUOTE', message: 'No quote available for this intent' });
        }
        return res.json({
            protocol: 'cow',
            sellToken: cowQuote.sellToken,
            buyToken: cowQuote.buyToken,
            sellAmount: cowQuote.sellAmount,
            buyAmount: cowQuote.buyAmount,
            feeAmount: cowQuote.feeAmount,
            validTo: cowQuote.validTo,
        });
    }
    catch (err) {
        return res.status(500).json({ errorCode: 'QUOTE_ERROR', message: err.message });
    }
});
app.use((err, _req, res, _next) => {
    console.error('[SOLVER] Unhandled error:', err);
    res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: err.message });
});
const server = app.listen(PORT, () => {
    console.log(`[SOLVER] HIEF Solver running on port ${PORT}, solverId: ${SOLVER_ID}`);
});
exports.server = server;
//# sourceMappingURL=server.js.map