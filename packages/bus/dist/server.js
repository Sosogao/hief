"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getServer = exports.app = void 0;
exports.start = start;
const express_1 = __importDefault(require("express"));
const intents_1 = require("./api/intents");
const solutions_1 = require("./api/solutions");
const proposals_1 = require("./api/proposals");
const database_1 = require("./db/database");
const app = (0, express_1.default)();
exports.app = app;
const PORT = process.env.PORT || 3001;
// Middleware
app.use(express_1.default.json({ limit: '1mb' }));
app.use((req, _res, next) => {
    console.log(`[BUS] ${req.method} ${req.path}`);
    next();
});
// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'hief-bus', version: '0.1.0' });
});
// Routes
app.use('/v1/intents', intents_1.intentsRouter);
app.use('/v1/solutions', solutions_1.solutionsRouter);
app.use('/v1/intents', proposals_1.proposalsRouter);
app.use('/v1', solutions_1.solutionsRouter);
// Error handler
app.use((err, _req, res, _next) => {
    console.error('[BUS] Unhandled error:', err);
    res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: err.message });
});
let server;
async function start() {
    await (0, database_1.initDb)();
    server = app.listen(PORT, () => {
        console.log(`[BUS] HIEF Intent Bus running on port ${PORT}`);
    });
}
if (require.main === module) {
    start().catch(console.error);
}
const getServer = () => server;
exports.getServer = getServer;
//# sourceMappingURL=server.js.map