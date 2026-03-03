/**
 * HIEF Tenderly Client
 *
 * Wraps the Tenderly Simulation REST API.
 * Supports:
 *  - Single transaction simulation
 *  - Bundle (multi-tx) simulation
 *  - Graceful degradation when API key is absent (returns SKIP)
 *
 * API reference: https://docs.tenderly.co/reference/api
 */
import { TenderlyConfig, TenderlySimulationRequest, TenderlySimulationResponse, TenderlyBundleResponse } from '../types';
export declare class TenderlyClient {
    private readonly http;
    private readonly config;
    constructor(config: TenderlyConfig);
    /**
     * Simulate a single transaction.
     * Returns null when Tenderly is unavailable (graceful degradation).
     */
    simulate(req: TenderlySimulationRequest): Promise<TenderlySimulationResponse | null>;
    /**
     * Simulate a bundle of transactions consecutively.
     * Useful for multi-step DeFi operations (approve → swap).
     */
    simulateBundle(reqs: TenderlySimulationRequest[]): Promise<TenderlyBundleResponse | null>;
    /**
     * Health check — verifies credentials are valid.
     */
    ping(): Promise<boolean>;
    private _handleError;
}
/**
 * Build a TenderlyClient from environment variables.
 * Returns null if required env vars are missing (simulation will be SKIP).
 */
export declare function buildTenderlyClientFromEnv(): TenderlyClient | null;
//# sourceMappingURL=tenderlyClient.d.ts.map