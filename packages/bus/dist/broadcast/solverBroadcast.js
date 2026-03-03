"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.broadcastToSolvers = broadcastToSolvers;
const axios_1 = __importDefault(require("axios"));
// Solver registry: in MVP, solvers are registered via environment variables
// Format: SOLVER_URLS=http://solver1:3001,http://solver2:3002
function getSolverUrls() {
    const envUrls = process.env.SOLVER_URLS || '';
    return envUrls
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean);
}
/**
 * Broadcast a new intent to all registered solvers.
 * Solvers can respond via the push mode (POST /solutions) or pull mode (GET /solver/quote).
 */
async function broadcastToSolvers(intentId, intentHash, intent) {
    const solverUrls = getSolverUrls();
    if (solverUrls.length === 0) {
        console.log('[BROADCAST] No solvers registered, skipping broadcast');
        return;
    }
    const payload = {
        intentId,
        intentHash,
        intent,
        policyRef: { policyVersion: 'v0.1' },
        quoteWindowMs: 30000,
    };
    const results = await Promise.allSettled(solverUrls.map((url) => axios_1.default.post(`${url}/solver/quote`, payload, { timeout: 5000 })));
    results.forEach((result, i) => {
        if (result.status === 'rejected') {
            console.warn(`[BROADCAST] Solver ${solverUrls[i]} failed:`, result.reason?.message);
        }
        else {
            console.log(`[BROADCAST] Solver ${solverUrls[i]} responded`);
        }
    });
}
//# sourceMappingURL=solverBroadcast.js.map