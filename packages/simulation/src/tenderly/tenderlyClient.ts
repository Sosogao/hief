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

import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  TenderlyConfig,
  TenderlySimulationRequest,
  TenderlySimulationResponse,
  TenderlyBundleRequest,
  TenderlyBundleResponse,
} from '../types';

const TENDERLY_BASE_URL = 'https://api.tenderly.co/api/v1';

export class TenderlyClient {
  private readonly http: AxiosInstance;
  private readonly config: TenderlyConfig;

  constructor(config: TenderlyConfig) {
    this.config = config;
    this.http = axios.create({
      baseURL: TENDERLY_BASE_URL,
      headers: {
        'X-Access-Key': config.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });
  }

  /**
   * Simulate a single transaction.
   * Returns null when Tenderly is unavailable (graceful degradation).
   */
  async simulate(
    req: TenderlySimulationRequest
  ): Promise<TenderlySimulationResponse | null> {
    const url = `/account/${this.config.accountSlug}/project/${this.config.projectSlug}/simulate`;

    // Apply defaults
    const payload: TenderlySimulationRequest = {
      simulation_type: 'full',
      save: false,
      save_if_fails: false,
      gas: 3_000_000,
      ...req,
      network_id: req.network_id ?? this.config.networkId,
    };

    try {
      const { data } = await this.http.post<TenderlySimulationResponse>(url, payload);
      return data;
    } catch (err) {
      return this._handleError(err, 'simulate');
    }
  }

  /**
   * Simulate a bundle of transactions consecutively.
   * Useful for multi-step DeFi operations (approve → swap).
   */
  async simulateBundle(
    reqs: TenderlySimulationRequest[]
  ): Promise<TenderlyBundleResponse | null> {
    const url = `/account/${this.config.accountSlug}/project/${this.config.projectSlug}/simulate-bundle`;

    const payload: TenderlyBundleRequest = {
      simulations: reqs.map((r) => ({
        simulation_type: 'full',
        save: false,
        gas: 3_000_000,
        ...r,
        network_id: r.network_id ?? this.config.networkId,
      })),
    };

    try {
      const { data } = await this.http.post<TenderlyBundleResponse>(url, payload);
      return data;
    } catch (err) {
      return this._handleError(err, 'simulateBundle');
    }
  }

  /**
   * Health check — verifies credentials are valid.
   */
  async ping(): Promise<boolean> {
    try {
      await this.http.get(
        `/account/${this.config.accountSlug}/project/${this.config.projectSlug}`
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _handleError(err: unknown, method: string): null {
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      const msg = err.response?.data?.error?.message ?? err.message;

      if (status === 401 || status === 403) {
        console.warn(`[TenderlyClient] ${method}: Auth failed (${status}) — ${msg}. Skipping simulation.`);
      } else if (status === 429) {
        console.warn(`[TenderlyClient] ${method}: Rate limited — skipping simulation.`);
      } else if (err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND') {
        console.warn(`[TenderlyClient] ${method}: Network unreachable — skipping simulation.`);
      } else {
        console.error(`[TenderlyClient] ${method}: Unexpected error (${status}) — ${msg}`);
      }
    } else {
      console.error(`[TenderlyClient] ${method}: Unknown error`, err);
    }
    return null;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a TenderlyClient from environment variables.
 * Returns null if required env vars are missing (simulation will be SKIP).
 */
export function buildTenderlyClientFromEnv(): TenderlyClient | null {
  const accountSlug = process.env.TENDERLY_ACCOUNT_SLUG;
  const projectSlug = process.env.TENDERLY_PROJECT_SLUG;
  const apiKey = process.env.TENDERLY_API_KEY;
  const networkId = process.env.TENDERLY_NETWORK_ID ?? '84532'; // Base Sepolia default

  if (!accountSlug || !projectSlug || !apiKey) {
    console.warn(
      '[TenderlyClient] Missing env vars (TENDERLY_ACCOUNT_SLUG / TENDERLY_PROJECT_SLUG / TENDERLY_API_KEY). ' +
      'L4 simulation will be SKIP.'
    );
    return null;
  }

  return new TenderlyClient({ accountSlug, projectSlug, apiKey, networkId });
}
