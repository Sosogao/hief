import type { HIEFIntent } from '@hief/common';
/**
 * Broadcast a new intent to all registered solvers.
 * Solvers can respond via the push mode (POST /solutions) or pull mode (GET /solver/quote).
 */
export declare function broadcastToSolvers(intentId: string, intentHash: string, intent: HIEFIntent): Promise<void>;
//# sourceMappingURL=solverBroadcast.d.ts.map