import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';

let db: SqlJsDatabase | null = null;
let dbPath: string | null = null;

export async function initDb(): Promise<SqlJsDatabase> {
  if (db) return db;

  const SQL = await initSqlJs();
  const dir = process.env.DB_DIR || path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  dbPath = path.join(dir, 'hief.db');

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  initSchema(db);
  return db;
}

export function getDb(): SqlJsDatabase {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function saveDb(): void {
  if (db && dbPath) {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }
}

function initSchema(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS intents (
      id TEXT PRIMARY KEY,
      intent_hash TEXT NOT NULL UNIQUE,
      smart_account TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      deadline INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'BROADCAST',
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
    CREATE INDEX IF NOT EXISTS idx_intents_smart_account ON intents(smart_account);

    CREATE TABLE IF NOT EXISTS solutions (
      id TEXT PRIMARY KEY,
      solution_hash TEXT NOT NULL UNIQUE,
      intent_id TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      solver_id TEXT NOT NULL,
      expected_out TEXT NOT NULL,
      fee TEXT NOT NULL,
      valid_until INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'SUBMITTED',
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_solutions_intent_id ON solutions(intent_id);
    CREATE INDEX IF NOT EXISTS idx_solutions_status ON solutions(status);

    CREATE TABLE IF NOT EXISTS policy_results (
      id TEXT PRIMARY KEY,
      intent_hash TEXT NOT NULL,
      solution_id TEXT,
      solution_hash TEXT,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      findings TEXT NOT NULL,
      execution_diff TEXT,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_policy_results_intent_hash ON policy_results(intent_hash);

    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      solution_id TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      safe_address TEXT NOT NULL,
      safe_tx_hash TEXT,
      status TEXT NOT NULL DEFAULT 'CREATED',
      human_summary TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
}

// Helper: run a query and return all rows as objects
export function dbAll<T = Record<string, unknown>>(
  database: SqlJsDatabase,
  sql: string,
  params: (string | number | null)[] = []
): T[] {
  const stmt = database.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

// Helper: run a query and return the first row
export function dbGet<T = Record<string, unknown>>(
  database: SqlJsDatabase,
  sql: string,
  params: (string | number | null)[] = []
): T | undefined {
  const rows = dbAll<T>(database, sql, params);
  return rows[0];
}

// Helper: run a write query
export function dbRun(
  database: SqlJsDatabase,
  sql: string,
  params: (string | number | null)[] = []
): void {
  const stmt = database.prepare(sql);
  stmt.run(params);
  stmt.free();
  saveDb();
}

export function closeDb(): void {
  if (db) {
    saveDb();
    db.close();
    db = null;
  }
}
