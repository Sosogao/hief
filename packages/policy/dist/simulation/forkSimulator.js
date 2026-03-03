"use strict";
/**
 * HIEF Policy Engine — Fork Simulator Bridge
 *
 * Bridges the Policy Engine (L1-L3 static rules) with the
 * @hief/simulation package (L4 Tenderly fork simulation).
 *
 * This module is the single integration point: the Policy Engine
 * calls `runL4Simulation()` and receives a structured SimulationPolicyResult.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runL4Simulation = runL4Simulation;
exports.resetSimulationEngine = resetSimulationEngine;
const simulation_1 = require("@hief/simulation");
// ── Singleton SimulationEngine (lazy init) ────────────────────────────────────
let _engine = null;
function getEngine() {
    if (!_engine) {
        const tenderlyClient = (0, simulation_1.buildTenderlyClientFromEnv)();
        _engine = new simulation_1.SimulationEngine(tenderlyClient);
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
async function runL4Simulation(solution) {
    return getEngine().verify(solution);
}
/**
 * Reset the engine singleton (useful for testing with different configs).
 */
function resetSimulationEngine() {
    _engine = null;
}
//# sourceMappingURL=forkSimulator.js.map