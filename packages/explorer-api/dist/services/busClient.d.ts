/**
 * BusClient — reads Intent Bus SQLite database directly for Explorer queries.
 * The Bus uses sql.js (in-memory + file persistence), so we read the same DB file.
 */
import { Database } from 'sql.js';
export declare function getBusDb(): Promise<Database>;
/** Reload DB from disk (call before each query to get fresh data) */
export declare function reloadBusDb(): Promise<Database>;
export interface IntentRow {
    id: string;
    intent_hash: string;
    smart_account: string;
    chain_id: number;
    deadline: number;
    status: string;
    data: string;
    created_at: number;
    updated_at: number;
}
export declare function getIntents(opts: {
    limit?: number;
    offset?: number;
    status?: string;
    address?: string;
    chainId?: number;
}): Promise<{
    intents: IntentRow[];
    total: number;
}>;
export declare function getIntentById(intentId: string): Promise<IntentRow | null>;
export declare function getSolutionsForIntent(intentId: string): Promise<any[]>;
export declare function getPolicyResultForIntent(intentHash: string): Promise<any | null>;
export interface BusStats {
    totalIntents: number;
    byStatus: Record<string, number>;
    totalSolutions: number;
    uniqueAddresses: number;
    recentActivity: {
        hour: number;
        count: number;
    }[];
}
export declare function getBusStats(): Promise<BusStats>;
//# sourceMappingURL=busClient.d.ts.map