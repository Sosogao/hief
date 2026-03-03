import axios from 'axios';
import type { HIEFIntent } from '@hief/common';

// Solver registry: in MVP, solvers are registered via environment variables
// Format: SOLVER_URLS=http://solver1:3001,http://solver2:3002
function getSolverUrls(): string[] {
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
export async function broadcastToSolvers(
  intentId: string,
  intentHash: string,
  intent: HIEFIntent
): Promise<void> {
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

  const results = await Promise.allSettled(
    solverUrls.map((url) =>
      axios.post(`${url}/solver/quote`, payload, { timeout: 5000 })
    )
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.warn(`[BROADCAST] Solver ${solverUrls[i]} failed:`, result.reason?.message);
    } else {
      console.log(`[BROADCAST] Solver ${solverUrls[i]} responded`);
    }
  });
}
