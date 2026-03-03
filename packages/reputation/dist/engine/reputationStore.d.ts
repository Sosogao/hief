/**
 * HIEF Reputation Store
 *
 * Manages persistent storage of address metrics, intent records,
 * and reputation snapshots using SQLite (sql.js for portability).
 */
import type { AddressMetrics, IntentRecord, ReputationSnapshot } from '../types';
import { ScoringEngine } from './scoringEngine';
export declare class ReputationStore {
    private db;
    private engine;
    constructor(engine?: ScoringEngine);
    init(): Promise<void>;
    private createTables;
    getMetrics(address: string, chainId: number): AddressMetrics;
    saveMetrics(metrics: AddressMetrics): void;
    saveIntentRecord(record: IntentRecord): void;
    getIntentHistory(address: string, chainId: number, limit?: number): IntentRecord[];
    getCachedSnapshot(address: string, chainId: number): ReputationSnapshot | null;
    saveSnapshot(snapshot: ReputationSnapshot): void;
    /**
     * Compute (or return cached) reputation snapshot for an address.
     */
    getOrComputeSnapshot(address: string, chainId: number, forceRefresh?: boolean): Promise<{
        snapshot: ReputationSnapshot;
        cached: boolean;
    }>;
    /**
     * Process an intent event: update metrics and invalidate cache.
     */
    processIntentEvent(record: IntentRecord): ReputationSnapshot;
    getLeaderboard(chainId: number, limit?: number): Array<{
        address: string;
        score: number;
        tier: string;
    }>;
}
//# sourceMappingURL=reputationStore.d.ts.map