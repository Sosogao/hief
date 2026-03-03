/**
 * @hief/simulation — HIEF L4 Policy Layer
 *
 * Exports:
 *  - SimulationEngine: main orchestrator
 *  - TenderlyClient + buildTenderlyClientFromEnv: API client
 *  - DiffEngine + helpers: execution diff parsing
 *  - All types
 */

export { SimulationEngine } from './engine/simulationEngine';
export { TenderlyClient, buildTenderlyClientFromEnv } from './tenderly/tenderlyClient';
export { DiffEngine, calcNetOutflowUsd, findUnlimitedApprovals } from './diff/diffEngine';
export * from './types';
