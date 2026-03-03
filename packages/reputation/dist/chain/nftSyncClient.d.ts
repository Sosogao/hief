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
 * NFT Sync Client - writes off-chain reputation snapshots to the on-chain contract.
 *
 * This is intentionally kept as a thin adapter layer. The heavy computation
 * stays off-chain; the contract is just the verifiable commitment layer.
 */
export declare class NftSyncClient {
    private config;
    private enabled;
    constructor(config: ChainConfig);
    /**
     * Sync a reputation snapshot to the on-chain NFT contract.
     *
     * @param snapshot The computed reputation snapshot from ScoringEngine
     * @returns SyncResult with tx hash and block number, or null if disabled
     */
    syncToChain(snapshot: ReputationSnapshot): Promise<SyncResult | null>;
    /**
     * Batch sync multiple snapshots.
     * Processes sequentially to avoid nonce conflicts.
     */
    batchSyncToChain(snapshots: ReputationSnapshot[]): Promise<(SyncResult | null)[]>;
    get isEnabled(): boolean;
}
//# sourceMappingURL=nftSyncClient.d.ts.map