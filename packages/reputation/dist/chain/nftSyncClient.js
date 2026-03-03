"use strict";
/**
 * NFT Sync Client
 *
 * Bridges the off-chain ScoringEngine with the on-chain ReputationNFT contract.
 * After computing a new snapshot, call `syncToChain()` to write the score on-chain.
 *
 * In Phase 1: Uses a hot wallet (UPDATER_ROLE) to submit transactions.
 * In Phase 3: Will use TEE-signed proofs to remove the trust assumption.
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
exports.NftSyncClient = void 0;
/**
 * Maps string risk tier to on-chain uint8 value
 */
function tierToUint8(tier) {
    const map = {
        UNKNOWN: 0,
        LOW: 1,
        STANDARD: 2,
        TRUSTED: 3,
        ELITE: 4,
    };
    return map[tier];
}
/**
 * NFT Sync Client - writes off-chain reputation snapshots to the on-chain contract.
 *
 * This is intentionally kept as a thin adapter layer. The heavy computation
 * stays off-chain; the contract is just the verifiable commitment layer.
 */
class NftSyncClient {
    constructor(config) {
        this.config = config;
        // Only enabled if all required config is present
        this.enabled = !!(config.rpcUrl &&
            config.contractAddress &&
            config.updaterPrivateKey &&
            config.contractAddress !== '0x0000000000000000000000000000000000000000');
    }
    /**
     * Sync a reputation snapshot to the on-chain NFT contract.
     *
     * @param snapshot The computed reputation snapshot from ScoringEngine
     * @returns SyncResult with tx hash and block number, or null if disabled
     */
    async syncToChain(snapshot) {
        if (!this.enabled) {
            console.log(`[NftSyncClient] Chain sync disabled (no config). Skipping for ${snapshot.address}`);
            return null;
        }
        try {
            // Dynamic import of ethers to avoid hard dependency in test environments
            const { ethers } = await Promise.resolve().then(() => __importStar(require('ethers')));
            const provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
            const signer = new ethers.Wallet(this.config.updaterPrivateKey, provider);
            // Minimal ABI for the updateReputation function
            const abi = [
                'function updateReputation(address account, uint16 finalScore, uint16 compositeScore, uint16 successScore, uint16 volumeScore, uint16 alphaScore, uint16 diversityScore, uint8 riskTier, bytes32 snapshotId) external',
            ];
            const contract = new ethers.Contract(this.config.contractAddress, abi, signer);
            const tx = await contract.updateReputation(snapshot.address, Math.round(snapshot.scores.final), Math.round(snapshot.scores.composite), Math.round(snapshot.scores.success), Math.round(snapshot.scores.volume), Math.round(snapshot.scores.alpha), Math.round(snapshot.scores.diversity), tierToUint8(snapshot.riskTier), ethers.id(snapshot.snapshotId));
            const receipt = await tx.wait();
            console.log(`[NftSyncClient] Synced ${snapshot.address} to chain. tx=${receipt.hash}`);
            return {
                txHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed,
            };
        }
        catch (err) {
            console.error(`[NftSyncClient] Failed to sync ${snapshot.address}:`, err);
            throw err;
        }
    }
    /**
     * Batch sync multiple snapshots.
     * Processes sequentially to avoid nonce conflicts.
     */
    async batchSyncToChain(snapshots) {
        const results = [];
        for (const snapshot of snapshots) {
            const result = await this.syncToChain(snapshot);
            results.push(result);
        }
        return results;
    }
    get isEnabled() {
        return this.enabled;
    }
}
exports.NftSyncClient = NftSyncClient;
//# sourceMappingURL=nftSyncClient.js.map