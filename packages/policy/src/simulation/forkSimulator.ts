/**
 * HIEF Policy Engine — Fork Simulator Bridge
 *
 * Bridges the Policy Engine (L1-L3 static rules) with the
 * @hief/simulation package (L4 Tenderly fork simulation).
 *
 * This module is the single integration point: the Policy Engine
 * calls `runL4Simulation()` and receives a structured SimulationPolicyResult.
 */

import type { HIEFSolution } from '@hief/common';
import {
  SimulationEngine,
  buildTenderlyClientFromEnv,
} from '@hief/simulation';

export type { SimulationPolicyResult } from '@hief/simulation';

// ── Singleton SimulationEngine (lazy init) ────────────────────────────────────

let _engine: SimulationEngine | null = null;

function getEngine(): SimulationEngine {
  if (!_engine) {
    const tenderlyClient = buildTenderlyClientFromEnv();
    _engine = new SimulationEngine(tenderlyClient);
  }
  return _engine;
}

/**
 * Run L4 fork simulation for a given HIEF Solution.
 *
 * Returns:
 *  - PASS: simulation succeeded, all rules passed
 *  - FAIL: simulation revealed policy violations (CRITICAL or HIGH)
 *  - SKIP: Tenderly not configured or unreachable (graceful degradation)
 */
export async function runL4Simulation(solution: HIEFSolution) {
  return getEngine().verify(solution as any);
}

/**
 * Reset the engine singleton (useful for testing with different configs).
 */
export function resetSimulationEngine(): void {
  _engine = null;
}
