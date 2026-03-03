"use strict";
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
exports.initDb = initDb;
exports.getDb = getDb;
exports.saveDb = saveDb;
exports.dbAll = dbAll;
exports.dbGet = dbGet;
exports.dbRun = dbRun;
exports.closeDb = closeDb;
const sql_js_1 = __importDefault(require("sql.js"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
let db = null;
let dbPath = null;
async function initDb() {
    if (db)
        return db;
    const SQL = await (0, sql_js_1.default)();
    const dir = process.env.DB_DIR || path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    dbPath = path.join(dir, 'hief.db');
    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
    }
    else {
        db = new SQL.Database();
    }
    initSchema(db);
    return db;
}
function getDb() {
    if (!db) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return db;
}
function saveDb() {
    if (db && dbPath) {
        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
    }
}
function initSchema(database) {
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
// Helper: run a query and return the first row
function dbGet(database, sql, params = []) {
    const rows = dbAll(database, sql, params);
    return rows[0];
}
// Helper: run a write query
function dbRun(database, sql, params = []) {
    const stmt = database.prepare(sql);
    stmt.run(params);
    stmt.free();
    saveDb();
}
function closeDb() {
    if (db) {
        saveDb();
        db.close();
        db = null;
    }
}
//# sourceMappingURL=database.js.map