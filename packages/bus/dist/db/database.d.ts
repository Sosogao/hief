import { Database as SqlJsDatabase } from 'sql.js';
export declare function initDb(): Promise<SqlJsDatabase>;
export declare function getDb(): SqlJsDatabase;
export declare function saveDb(): void;
export declare function dbAll<T = Record<string, unknown>>(database: SqlJsDatabase, sql: string, params?: (string | number | null)[]): T[];
export declare function dbGet<T = Record<string, unknown>>(database: SqlJsDatabase, sql: string, params?: (string | number | null)[]): T | undefined;
export declare function dbRun(database: SqlJsDatabase, sql: string, params?: (string | number | null)[]): void;
export declare function closeDb(): void;
//# sourceMappingURL=database.d.ts.map