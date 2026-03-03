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
export type { SimulationPolicyResult } from '@hief/simulation';
/**
 * Run L4 fork simulation for a given HIEF Solution.
 *
 * Returns:
 *  - PASS: simulation succeeded, all rules passed
 *  - FAIL: simulation revealed policy violations (CRITICAL or HIGH)
 *  - SKIP: Tenderly not configured or unreachable (graceful degradation)
 */
export declare function runL4Simulation(solution: HIEFSolution): Promise<import("@hief/simulation").SimulationPolicyResult>;
/**
 * Reset the engine singleton (useful for testing with different configs).
 */
export declare function resetSimulationEngine(): void;
//# sourceMappingURL=forkSimulator.d.ts.map