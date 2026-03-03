/**
 * HIEF Reputation Store
 *
 * Manages persistent storage of address metrics, intent records,
 * and reputation snapshots using SQLite (sql.js for portability).
 */

import initSqlJs, { Database } from 'sql.js';
import type { AddressMetrics, IntentRecord, ReputationSnapshot } from '../types';
import { ScoringEngine } from './scoringEngine';

export class ReputationStore {
  private db!: Database;
  private engine: ScoringEngine;

  constructor(engine?: ScoringEngine) {
    this.engine = engine ?? new ScoringEngine();
  }

  async init(): Promise<void> {
    const SQL = await initSqlJs();
    this.db = new SQL.Database();
    this.createTables();
  }

  private createTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS address_metrics (
        address     TEXT NOT NULL,
        chain_id    INTEGER NOT NULL,
        data        TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (address, chain_id)
      );

      CREATE TABLE IF NOT EXISTS intent_records (
        intent_id         TEXT PRIMARY KEY,
        address           TEXT NOT NULL,
        chain_id          INTEGER NOT NULL,
        intent_type       TEXT NOT NULL,
        input_token       TEXT NOT NULL,
        output_token      TEXT NOT NULL,
        input_amount_usd  REAL NOT NULL,
        status            TEXT NOT NULL,
        submitted_at      INTEGER NOT NULL,
        executed_at       INTEGER,
        alpha_score       REAL,
        skill_id          TEXT,
        actual_slippage   INTEGER
      );

      CREATE TABLE IF NOT EXISTS reputation_snapshots (
        snapshot_id   TEXT PRIMARY KEY,
        address       TEXT NOT NULL,
        chain_id      INTEGER NOT NULL,
        data          TEXT NOT NULL,
        computed_at   INTEGER NOT NULL,
        valid_until   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_intent_address ON intent_records(address, chain_id);
      CREATE INDEX IF NOT EXISTS idx_snapshot_address ON reputation_snapshots(address, chain_id, computed_at DESC);
    `);
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────────

  getMetrics(address: string, chainId: number): AddressMetrics {
    const stmt = this.db.prepare(
      'SELECT data FROM address_metrics WHERE address = ? AND chain_id = ?'
    );
    stmt.bind([address.toLowerCase(), chainId]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as { data: string };
      stmt.free();
      return JSON.parse(row.data) as AddressMetrics;
    }
    stmt.free();
    return ScoringEngine.emptyMetrics(address, chainId);
  }

  saveMetrics(metrics: AddressMetrics): void {
    this.db.run(
      `INSERT OR REPLACE INTO address_metrics (address, chain_id, data, updated_at)
       VALUES (?, ?, ?, ?)`,
      [metrics.address.toLowerCase(), metrics.chainId, JSON.stringify(metrics), metrics.updatedAt]
    );
  }

  // ─── Intent Records ───────────────────────────────────────────────────────────

  saveIntentRecord(record: IntentRecord): void {
    this.db.run(
      `INSERT OR REPLACE INTO intent_records
       (intent_id, address, chain_id, intent_type, input_token, output_token,
        input_amount_usd, status, submitted_at, executed_at, alpha_score, skill_id, actual_slippage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.intentId,
        record.address.toLowerCase(),
        record.chainId,
        record.intentType,
        record.inputToken,
        record.outputToken,
        record.inputAmountUSD,
        record.status,
        record.submittedAt,
        record.executedAt ?? null,
        record.alphaScore ?? null,
        record.skillId ?? null,
        record.actualSlippageBps ?? null,
      ]
    );
  }

  getIntentHistory(address: string, chainId: number, limit = 50): IntentRecord[] {
    const stmt = this.db.prepare(
      `SELECT * FROM intent_records
       WHERE address = ? AND chain_id = ?
       ORDER BY submitted_at DESC LIMIT ?`
    );
    stmt.bind([address.toLowerCase(), chainId, limit]);
    const records: IntentRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      records.push({
        intentId: row.intent_id,
        address: row.address,
        chainId: row.chain_id,
        intentType: row.intent_type,
        inputToken: row.input_token,
        outputToken: row.output_token,
        inputAmountUSD: row.input_amount_usd,
        status: row.status,
        submittedAt: row.submitted_at,
        executedAt: row.executed_at ?? undefined,
        alphaScore: row.alpha_score ?? undefined,
        skillId: row.skill_id ?? undefined,
        actualSlippageBps: row.actual_slippage ?? undefined,
      });
    }
    stmt.free();
    return records;
  }

  // ─── Snapshots ────────────────────────────────────────────────────────────────

  getCachedSnapshot(address: string, chainId: number): ReputationSnapshot | null {
    const now = Date.now();
    const stmt = this.db.prepare(
      `SELECT data FROM reputation_snapshots
       WHERE address = ? AND chain_id = ? AND valid_until > ?
       ORDER BY computed_at DESC LIMIT 1`
    );
    stmt.bind([address.toLowerCase(), chainId, now]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as { data: string };
      stmt.free();
      return JSON.parse(row.data) as ReputationSnapshot;
    }
    stmt.free();
    return null;
  }

  saveSnapshot(snapshot: ReputationSnapshot): void {
    this.db.run(
      `INSERT OR REPLACE INTO reputation_snapshots
       (snapshot_id, address, chain_id, data, computed_at, valid_until)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        snapshot.snapshotId,
        snapshot.address.toLowerCase(),
        snapshot.chainId,
        JSON.stringify(snapshot),
        snapshot.computedAt,
        snapshot.validUntil,
      ]
    );
  }

  /**
   * Compute (or return cached) reputation snapshot for an address.
   */
  async getOrComputeSnapshot(
    address: string,
    chainId: number,
    forceRefresh = false
  ): Promise<{ snapshot: ReputationSnapshot; cached: boolean }> {
    if (!forceRefresh) {
      const cached = this.getCachedSnapshot(address, chainId);
      if (cached) return { snapshot: cached, cached: true };
    }

    const metrics = this.getMetrics(address, chainId);
    const snapshot = this.engine.computeSnapshot(metrics);
    this.saveSnapshot(snapshot);

    return { snapshot, cached: false };
  }

  /**
   * Process an intent event: update metrics and invalidate cache.
   */
  processIntentEvent(record: IntentRecord): ReputationSnapshot {
    // Save raw record
    this.saveIntentRecord(record);

    // Update metrics incrementally
    const metrics = this.getMetrics(record.address, record.chainId);
    const updated = this.engine.applyIntentEvent(metrics, {
      status: record.status,
      inputAmountUSD: record.inputAmountUSD,
      alphaScore: record.alphaScore,
      skillId: record.skillId,
      actualSlippageBps: record.actualSlippageBps,
      executedAt: record.executedAt,
      inputToken: record.inputToken,
      outputToken: record.outputToken,
      chainId: record.chainId,
    });
    this.saveMetrics(updated);

    // Recompute snapshot
    const snapshot = this.engine.computeSnapshot(updated);
    this.saveSnapshot(snapshot);

    return snapshot;
  }

  // ─── Leaderboard ─────────────────────────────────────────────────────────────

  getLeaderboard(chainId: number, limit = 20): Array<{ address: string; score: number; tier: string }> {
    const stmt = this.db.prepare(
      `SELECT address, data FROM address_metrics WHERE chain_id = ? ORDER BY updated_at DESC LIMIT 100`
    );
    stmt.bind([chainId]);
    const results: Array<{ address: string; score: number; tier: string }> = [];

    while (stmt.step()) {
      const row = stmt.getAsObject() as { address: string; data: string };
      const metrics = JSON.parse(row.data) as AddressMetrics;
      const scores = this.engine.computeScores(metrics);
      const tier = this.engine.computeRiskTier(scores.final);
      results.push({ address: row.address, score: scores.final, tier });
    }
    stmt.free();

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
