/**
 * BusClient — reads Intent Bus SQLite database directly for Explorer queries.
 * The Bus uses sql.js (in-memory + file persistence), so we read the same DB file.
 */

import initSqlJs, { Database } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';

let db: Database | null = null;

const DB_PATH = process.env.BUS_DB_PATH ||
  path.join(process.cwd(), '../../packages/bus/data/hief.db');

export async function getBusDb(): Promise<Database> {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    // Return empty in-memory DB if bus hasn't started yet
    db = new SQL.Database();
    db.run(`
      CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY, intent_hash TEXT, smart_account TEXT,
        chain_id INTEGER, deadline INTEGER, status TEXT, data TEXT,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS solutions (
        id TEXT PRIMARY KEY, solution_hash TEXT, intent_id TEXT,
        intent_hash TEXT, solver_id TEXT, expected_out TEXT, fee TEXT,
        valid_until INTEGER, status TEXT, data TEXT,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS policy_results (
        id TEXT PRIMARY KEY, intent_hash TEXT, solution_id TEXT,
        solution_hash TEXT, status TEXT, summary TEXT, findings TEXT,
        execution_diff TEXT, data TEXT, created_at INTEGER
      );
    `);
  }
  return db;
}

/** Reload DB from disk (call before each query to get fresh data) */
export async function reloadBusDb(): Promise<Database> {
  db = null;
  return getBusDb();
}

function dbAll<T>(database: Database, sql: string, params: (string | number | null)[] = []): T[] {
  const stmt = database.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

// ─── Intent Queries ───────────────────────────────────────────────────────────

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

export async function getIntents(opts: {
  limit?: number;
  offset?: number;
  status?: string;
  address?: string;
  chainId?: number;
}): Promise<{ intents: IntentRow[]; total: number }> {
  const database = await reloadBusDb();
  const { limit = 20, offset = 0, status, address, chainId } = opts;

  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (status) { conditions.push('status = ?'); params.push(status); }
  if (address) { conditions.push('LOWER(smart_account) = LOWER(?)'); params.push(address); }
  if (chainId) { conditions.push('chain_id = ?'); params.push(chainId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRows = dbAll<{ cnt: number }>(database, `SELECT COUNT(*) as cnt FROM intents ${where}`, params);
  const total = countRows[0]?.cnt ?? 0;

  const intents = dbAll<IntentRow>(
    database,
    `SELECT * FROM intents ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return { intents, total };
}

export async function getIntentById(intentId: string): Promise<IntentRow | null> {
  const database = await reloadBusDb();
  const rows = dbAll<IntentRow>(database, 'SELECT * FROM intents WHERE id = ?', [intentId]);
  return rows[0] ?? null;
}

export async function getSolutionsForIntent(intentId: string): Promise<any[]> {
  const database = await reloadBusDb();
  return dbAll(database, 'SELECT * FROM solutions WHERE intent_id = ? ORDER BY created_at DESC', [intentId]);
}

export async function getPolicyResultForIntent(intentHash: string): Promise<any | null> {
  const database = await reloadBusDb();
  const rows = dbAll(database, 'SELECT * FROM policy_results WHERE intent_hash = ? ORDER BY created_at DESC LIMIT 1', [intentHash]);
  return rows[0] ?? null;
}

// ─── Stats Queries ────────────────────────────────────────────────────────────

export interface BusStats {
  totalIntents: number;
  byStatus: Record<string, number>;
  totalSolutions: number;
  uniqueAddresses: number;
  recentActivity: { hour: number; count: number }[];
}

export async function getBusStats(): Promise<BusStats> {
  const database = await reloadBusDb();

  const total = (dbAll<{ cnt: number }>(database, 'SELECT COUNT(*) as cnt FROM intents')[0]?.cnt) ?? 0;
  const totalSolutions = (dbAll<{ cnt: number }>(database, 'SELECT COUNT(*) as cnt FROM solutions')[0]?.cnt) ?? 0;
  const uniqueAddresses = (dbAll<{ cnt: number }>(database, 'SELECT COUNT(DISTINCT smart_account) as cnt FROM intents')[0]?.cnt) ?? 0;

  const statusRows = dbAll<{ status: string; cnt: number }>(
    database, 'SELECT status, COUNT(*) as cnt FROM intents GROUP BY status'
  );
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) {
    byStatus[row.status] = row.cnt;
  }

  // Activity in last 24 hours by hour
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const activityRows = dbAll<{ hour: number; count: number }>(
    database,
    `SELECT CAST((created_at - ${dayAgo}) / 3600 AS INTEGER) as hour, COUNT(*) as count
     FROM intents WHERE created_at >= ${dayAgo}
     GROUP BY hour ORDER BY hour`
  );

  return { totalIntents: total, byStatus, totalSolutions, uniqueAddresses, recentActivity: activityRows };
}
