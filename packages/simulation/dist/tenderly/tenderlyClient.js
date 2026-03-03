"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenderlyClient = void 0;
exports.buildTenderlyClientFromEnv = buildTenderlyClientFromEnv;
const axios_1 = __importStar(require("axios"));
const TENDERLY_BASE_URL = 'https://api.tenderly.co/api/v1';
class TenderlyClient {
    http;
    config;
    constructor(config) {
        this.config = config;
        this.http = axios_1.default.create({
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
    async simulate(req) {
        const url = `/account/${this.config.accountSlug}/project/${this.config.projectSlug}/simulate`;
        // Apply defaults
        const payload = {
            simulation_type: 'full',
            save: false,
            save_if_fails: false,
            gas: 3_000_000,
            ...req,
            network_id: req.network_id ?? this.config.networkId,
        };
        try {
            const { data } = await this.http.post(url, payload);
            return data;
        }
        catch (err) {
            return this._handleError(err, 'simulate');
        }
    }
    /**
     * Simulate a bundle of transactions consecutively.
     * Useful for multi-step DeFi operations (approve → swap).
     */
    async simulateBundle(reqs) {
        const url = `/account/${this.config.accountSlug}/project/${this.config.projectSlug}/simulate-bundle`;
        const payload = {
            simulations: reqs.map((r) => ({
                simulation_type: 'full',
                save: false,
                gas: 3_000_000,
                ...r,
                network_id: r.network_id ?? this.config.networkId,
            })),
        };
        try {
            const { data } = await this.http.post(url, payload);
            return data;
        }
        catch (err) {
            return this._handleError(err, 'simulateBundle');
        }
    }
    /**
     * Health check — verifies credentials are valid.
     */
    async ping() {
        try {
            await this.http.get(`/account/${this.config.accountSlug}/project/${this.config.projectSlug}`);
            return true;
        }
        catch {
            return false;
        }
    }
    // ── Private ──────────────────────────────────────────────────────────────
    _handleError(err, method) {
        if (err instanceof axios_1.AxiosError) {
            const status = err.response?.status;
            const msg = err.response?.data?.error?.message ?? err.message;
            if (status === 401 || status === 403) {
                console.warn(`[TenderlyClient] ${method}: Auth failed (${status}) — ${msg}. Skipping simulation.`);
            }
            else if (status === 429) {
                console.warn(`[TenderlyClient] ${method}: Rate limited — skipping simulation.`);
            }
            else if (err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND') {
                console.warn(`[TenderlyClient] ${method}: Network unreachable — skipping simulation.`);
            }
            else {
                console.error(`[TenderlyClient] ${method}: Unexpected error (${status}) — ${msg}`);
            }
        }
        else {
            console.error(`[TenderlyClient] ${method}: Unknown error`, err);
        }
        return null;
    }
}
exports.TenderlyClient = TenderlyClient;
// ── Factory ──────────────────────────────────────────────────────────────────
/**
 * Build a TenderlyClient from environment variables.
 * Returns null if required env vars are missing (simulation will be SKIP).
 */
function buildTenderlyClientFromEnv() {
    const accountSlug = process.env.TENDERLY_ACCOUNT_SLUG;
    const projectSlug = process.env.TENDERLY_PROJECT_SLUG;
    const apiKey = process.env.TENDERLY_API_KEY;
    const networkId = process.env.TENDERLY_NETWORK_ID ?? '84532'; // Base Sepolia default
    if (!accountSlug || !projectSlug || !apiKey) {
        console.warn('[TenderlyClient] Missing env vars (TENDERLY_ACCOUNT_SLUG / TENDERLY_PROJECT_SLUG / TENDERLY_API_KEY). ' +
            'L4 simulation will be SKIP.');
        return null;
    }
    return new TenderlyClient({ accountSlug, projectSlug, apiKey, networkId });
}
//# sourceMappingURL=tenderlyClient.js.map