"use strict";
/**
 * BusClient — reads Intent Bus SQLite database directly for Explorer queries.
 * The Bus uses sql.js (in-memory + file persistence), so we read the same DB file.
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBusDb = getBusDb;
exports.reloadBusDb = reloadBusDb;
exports.getIntents = getIntents;
exports.getIntentById = getIntentById;
exports.getSolutionsForIntent = getSolutionsForIntent;
exports.getPolicyResultForIntent = getPolicyResultForIntent;
exports.getBusStats = getBusStats;
const sql_js_1 = __importDefault(require("sql.js"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
let db = null;
const DB_PATH = process.env.BUS_DB_PATH ||
    path.join(process.cwd(), '../../packages/bus/data/hief.db');
async function getBusDb() {
    if (db)
        return db;
    const SQL = await (0, sql_js_1.default)();
    if (fs.existsSync(DB_PATH)) {
        const buf = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buf);
    }
    else {
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
async function reloadBusDb() {
    db = null;
    return getBusDb();
}
function dbAll(database, sql, params = []) {
    const stmt = database.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}
async function getIntents(opts) {
    const database = await reloadBusDb();
    const { limit = 20, offset = 0, status, address, chainId } = opts;
    const conditions = [];
    const params = [];
    if (status) {
        conditions.push('status = ?');
        params.push(status);
    }
    if (address) {
        conditions.push('LOWER(smart_account) = LOWER(?)');
        params.push(address);
    }
    if (chainId) {
        conditions.push('chain_id = ?');
        params.push(chainId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRows = dbAll(database, `SELECT COUNT(*) as cnt FROM intents ${where}`, params);
    const total = countRows[0]?.cnt ?? 0;
    const intents = dbAll(database, `SELECT * FROM intents ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { intents, total };
}
async function getIntentById(intentId) {
    const database = await reloadBusDb();
    const rows = dbAll(database, 'SELECT * FROM intents WHERE id = ?', [intentId]);
    return rows[0] ?? null;
}
async function getSolutionsForIntent(intentId) {
    const database = await reloadBusDb();
    return dbAll(database, 'SELECT * FROM solutions WHERE intent_id = ? ORDER BY created_at DESC', [intentId]);
}
async function getPolicyResultForIntent(intentHash) {
    const database = await reloadBusDb();
    const rows = dbAll(database, 'SELECT * FROM policy_results WHERE intent_hash = ? ORDER BY created_at DESC LIMIT 1', [intentHash]);
    return rows[0] ?? null;
}
async function getBusStats() {
    const database = await reloadBusDb();
    const total = (dbAll(database, 'SELECT COUNT(*) as cnt FROM intents')[0]?.cnt) ?? 0;
    const totalSolutions = (dbAll(database, 'SELECT COUNT(*) as cnt FROM solutions')[0]?.cnt) ?? 0;
    const uniqueAddresses = (dbAll(database, 'SELECT COUNT(DISTINCT smart_account) as cnt FROM intents')[0]?.cnt) ?? 0;
    const statusRows = dbAll(database, 'SELECT status, COUNT(*) as cnt FROM intents GROUP BY status');
    const byStatus = {};
    for (const row of statusRows) {
        byStatus[row.status] = row.cnt;
    }
    // Activity in last 24 hours by hour
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 86400;
    const activityRows = dbAll(database, `SELECT CAST((created_at - ${dayAgo}) / 3600 AS INTEGER) as hour, COUNT(*) as count
     FROM intents WHERE created_at >= ${dayAgo}
     GROUP BY hour ORDER BY hour`);
    return { totalIntents: total, byStatus, totalSolutions, uniqueAddresses, recentActivity: activityRows };
}
//# sourceMappingURL=busClient.js.map