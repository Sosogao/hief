/**
 * NFT Sync Client
 *
 * Bridges the off-chain ScoringEngine with the on-chain ReputationNFT contract.
 * After computing a new snapshot, call `syncToChain()` to write the score on-chain.
 *
 * In Phase 1: Uses a hot wallet (UPDATER_ROLE) to submit transactions.
 * In Phase 3: Will use TEE-signed proofs to remove the trust assumption.
 */

import { ReputationSnapshot } from '../types/index.js';

export interface ChainConfig {
  rpcUrl: string;
  contractAddress: string;
  updaterPrivateKey: string;
  chainId: number;
}

export interface SyncResult {
  txHash: string;
  blockNumber: number;
  gasUsed: bigint;
}

/**
 * Maps string risk tier to on-chain uint8 value
 */
function tierToUint8(tier: ReputationSnapshot['riskTier']): number {
  const map: Record<ReputationSnapshot['riskTier'], number> = {
    UNKNOWN:  0,
    LOW:      1,
    STANDARD: 2,
    TRUSTED:  3,
    ELITE:    4,
  };
  return map[tier];
}

/**
 * NFT Sync Client - writes off-chain reputation snapshots to the on-chain contract.
 *
 * This is intentionally kept as a thin adapter layer. The heavy computation
 * stays off-chain; the contract is just the verifiable commitment layer.
 */
export class NftSyncClient {
  private config: ChainConfig;
  private enabled: boolean;

  constructor(config: ChainConfig) {
    this.config = config;
    // Only enabled if all required config is present
    this.enabled = !!(
      config.rpcUrl &&
      config.contractAddress &&
      config.updaterPrivateKey &&
      config.contractAddress !== '0x0000000000000000000000000000000000000000'
    );
  }

  /**
   * Sync a reputation snapshot to the on-chain NFT contract.
   *
   * @param snapshot The computed reputation snapshot from ScoringEngine
   * @returns SyncResult with tx hash and block number, or null if disabled
   */
  async syncToChain(snapshot: ReputationSnapshot): Promise<SyncResult | null> {
    if (!this.enabled) {
      console.log(`[NftSyncClient] Chain sync disabled (no config). Skipping for ${snapshot.address}`);
      return null;
    }

    try {
      // Dynamic import of ethers to avoid hard dependency in test environments
      const { ethers } = await import('ethers');

      const provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
      const signer = new ethers.Wallet(this.config.updaterPrivateKey, provider);

      // Minimal ABI for the updateReputation function
      const abi = [
        'function updateReputation(address account, uint16 finalScore, uint16 compositeScore, uint16 successScore, uint16 volumeScore, uint16 alphaScore, uint16 diversityScore, uint8 riskTier, bytes32 snapshotId) external',
      ];

      const contract = new ethers.Contract(this.config.contractAddress, abi, signer);

      const tx = await contract.updateReputation(
        snapshot.address,
        Math.round(snapshot.scores.final),
        Math.round(snapshot.scores.composite),
        Math.round(snapshot.scores.success),
        Math.round(snapshot.scores.volume),
        Math.round(snapshot.scores.alpha),
        Math.round(snapshot.scores.diversity),
        tierToUint8(snapshot.riskTier),
        ethers.id(snapshot.snapshotId), // bytes32 from string
      );

      const receipt = await tx.wait();

      console.log(`[NftSyncClient] Synced ${snapshot.address} to chain. tx=${receipt.hash}`);

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    } catch (err) {
      console.error(`[NftSyncClient] Failed to sync ${snapshot.address}:`, err);
      throw err;
    }
  }

  /**
   * Batch sync multiple snapshots.
   * Processes sequentially to avoid nonce conflicts.
   */
  async batchSyncToChain(snapshots: ReputationSnapshot[]): Promise<(SyncResult | null)[]> {
    const results: (SyncResult | null)[] = [];
    for (const snapshot of snapshots) {
      const result = await this.syncToChain(snapshot);
      results.push(result);
    }
    return results;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}
