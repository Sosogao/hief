"use strict";
/**
 * HIEF NFT Sync Daemon
 *
 * Watches the off-chain Reputation API for score changes and automatically
 * syncs them to the on-chain ReputationNFT contract.
 *
 * Architecture:
 *   - Polls Reputation API every POLL_INTERVAL_MS for new/updated snapshots
 *   - Compares against last-known on-chain state (cached in SQLite)
 *   - If score delta >= SYNC_THRESHOLD, submits updateReputation() tx
 *   - Exposes REST API for status monitoring and manual triggers
 *
 * Ports: 3007
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
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const ethers_1 = require("ethers");
const sql_js_1 = __importDefault(require("sql.js"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ─── Config ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3007', 10);
const REPUTATION_API = process.env.REPUTATION_API_URL || 'http://localhost:3005';
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || '';
const NFT_ADDRESS = process.env.REPUTATION_NFT_ADDRESS || '';
const UPDATER_PRIVATE_KEY = process.env.TEST_WALLET_PRIVATE_KEY || '';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '99917', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10); // 30s
const SYNC_THRESHOLD = parseInt(process.env.SYNC_THRESHOLD || '10', 10); // min score delta to trigger sync
// Load .env
const envPath = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match && !process.env[match[1]]) {
            process.env[match[1]] = match[2].trim();
        }
    }
}
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || RPC_URL;
const nftAddress = process.env.REPUTATION_NFT_ADDRESS || NFT_ADDRESS;
const privateKey = process.env.TEST_WALLET_PRIVATE_KEY || UPDATER_PRIVATE_KEY;
// ─── NFT ABI ──────────────────────────────────────────────────────────────────
const NFT_ABI = [
    'function updateReputation(address account, uint16 finalScore, uint16 compositeScore, uint16 successScore, uint16 volumeScore, uint16 alphaScore, uint16 diversityScore, uint8 riskTier, bytes32 snapshotId) external',
    'function getReputation(address account) external view returns (uint16 finalScore, uint16 compositeScore, uint16 successScore, uint16 volumeScore, uint16 alphaScore, uint16 diversityScore, uint8 riskTier, uint32 updatedAt, bytes32 snapshotId)',
    'function tokenIdOf(address) external view returns (uint256)',
    'event ReputationUpdated(address indexed account, uint256 indexed tokenId, uint16 finalScore, uint8 riskTier, bytes32 snapshotId)',
];
const TIER_MAP = {
    UNKNOWN: 0, LOW: 1, STANDARD: 2, TRUSTED: 3, ELITE: 4,
};
// ─── State DB ─────────────────────────────────────────────────────────────────
const dbFilePath = path.resolve(__dirname, '../../../data/nft-sync.db');
fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
let db;
async function initDb() {
    const SQL = await (0, sql_js_1.default)();
    let database;
    if (fs.existsSync(dbFilePath)) {
        const buf = fs.readFileSync(dbFilePath);
        database = new SQL.Database(buf);
    }
    else {
        database = new SQL.Database();
    }
    database.run(`
    CREATE TABLE IF NOT EXISTS sync_state (
      address     TEXT NOT NULL,
      chain_id    INTEGER NOT NULL,
      last_score  INTEGER NOT NULL DEFAULT 0,
      last_tier   TEXT NOT NULL DEFAULT 'UNKNOWN',
      last_snapshot_id TEXT,
      last_sync_at INTEGER,
      last_tx_hash TEXT,
      sync_count  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (address, chain_id)
    );
    CREATE TABLE IF NOT EXISTS sync_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      address     TEXT NOT NULL,
      chain_id    INTEGER NOT NULL,
      old_score   INTEGER,
      new_score   INTEGER,
      delta       INTEGER,
      tx_hash     TEXT,
      status      TEXT NOT NULL,
      error       TEXT,
      synced_at   INTEGER NOT NULL
    );
  `);
    return database;
}
function saveDb() {
    if (db) {
        const data = db.export();
        fs.writeFileSync(dbFilePath, Buffer.from(data));
    }
}
const stats = {
    totalChecked: 0,
    totalSynced: 0,
    totalSkipped: 0,
    totalErrors: 0,
    lastPollAt: null,
    isRunning: false,
    chainEnabled: !!(rpcUrl && nftAddress && privateKey),
};
function getSyncState(address, chainId) {
    const stmt = db.prepare('SELECT * FROM sync_state WHERE address = ? AND chain_id = ?');
    stmt.bind([address.toLowerCase(), chainId]);
    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }
    stmt.free();
    return null;
}
function upsertSyncState(address, chainId, score, tier, snapshotId, txHash) {
    const now = Math.floor(Date.now() / 1000);
    db.run(`
    INSERT INTO sync_state (address, chain_id, last_score, last_tier, last_snapshot_id, last_sync_at, last_tx_hash, sync_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(address, chain_id) DO UPDATE SET
      last_score = excluded.last_score,
      last_tier = excluded.last_tier,
      last_snapshot_id = excluded.last_snapshot_id,
      last_sync_at = excluded.last_sync_at,
      last_tx_hash = excluded.last_tx_hash,
      sync_count = sync_count + 1
  `, [address.toLowerCase(), chainId, score, tier, snapshotId, now, txHash || null]);
    saveDb();
}
function logSync(address, chainId, oldScore, newScore, txHash, status, error) {
    db.run(`
    INSERT INTO sync_log (address, chain_id, old_score, new_score, delta, tx_hash, status, error, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [address.toLowerCase(), chainId, oldScore, newScore, newScore - oldScore, txHash, status, error || null, Math.floor(Date.now() / 1000)]);
    saveDb();
}
async function syncAddressToChain(snapshot) {
    if (!stats.chainEnabled) {
        console.log(`[NftSync] Chain sync disabled. Simulating for ${snapshot.address}`);
        return null;
    }
    const provider = new ethers_1.ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers_1.ethers.Wallet(privateKey, provider);
    const contract = new ethers_1.ethers.Contract(nftAddress, NFT_ABI, signer);
    const scores = snapshot.scores;
    const tx = await contract.updateReputation(snapshot.address, Math.round(scores.final), Math.round(scores.composite), Math.round(scores.successScore ?? scores.success ?? 0), Math.round(scores.volumeScore ?? scores.volume ?? 0), Math.round(scores.alphaScore ?? scores.alpha ?? 0), Math.round(scores.diversityScore ?? scores.diversity ?? 0), TIER_MAP[snapshot.riskTier] ?? 0, ethers_1.ethers.id(snapshot.snapshotId));
    const receipt = await tx.wait();
    return { txHash: receipt.hash, gasUsed: receipt.gasUsed.toString() };
}
async function pollAndSync() {
    if (stats.isRunning)
        return;
    stats.isRunning = true;
    stats.lastPollAt = Date.now();
    try {
        // Fetch leaderboard to get all known addresses
        const res = await fetch(`${REPUTATION_API}/v1/reputation/${CHAIN_ID}/leaderboard?limit=100`);
        if (!res.ok) {
            stats.isRunning = false;
            return;
        }
        const json = await res.json();
        const addresses = (json.data || []).map((r) => r.address);
        for (const address of addresses) {
            try {
                stats.totalChecked++;
                // Get fresh snapshot
                const snapRes = await fetch(`${REPUTATION_API}/v1/reputation/${CHAIN_ID}/${address}?forceRefresh=false`);
                if (!snapRes.ok)
                    continue;
                const snapJson = await snapRes.json();
                if (!snapJson.success)
                    continue;
                const snapshot = snapJson.data;
                const newScore = Math.round(snapshot.scores.final);
                const newTier = snapshot.riskTier;
                const snapshotId = snapshot.snapshotId;
                // Check against last known state
                const state = getSyncState(address, CHAIN_ID);
                const oldScore = state?.last_score ?? 0;
                const delta = Math.abs(newScore - oldScore);
                // Skip if delta below threshold and tier unchanged
                if (state && delta < SYNC_THRESHOLD && state.last_tier === newTier) {
                    stats.totalSkipped++;
                    continue;
                }
                console.log(`[NftSync] Score change detected for ${address.slice(0, 10)}...: ${oldScore} → ${newScore} (delta=${delta}, tier=${newTier})`);
                // Sync to chain
                let txHash = null;
                let txStatus = 'SIMULATED';
                if (stats.chainEnabled) {
                    try {
                        const result = await syncAddressToChain(snapshot);
                        if (result) {
                            txHash = result.txHash;
                            txStatus = 'SUCCESS';
                            stats.totalSynced++;
                            console.log(`[NftSync] ✅ Synced ${address.slice(0, 10)}... tx=${txHash}`);
                        }
                    }
                    catch (err) {
                        txStatus = 'FAILED';
                        stats.totalErrors++;
                        logSync(address, CHAIN_ID, oldScore, newScore, null, 'FAILED', err.message);
                        console.error(`[NftSync] ❌ Failed to sync ${address.slice(0, 10)}...:`, err.message);
                        continue;
                    }
                }
                else {
                    // Simulation mode: record as if synced
                    txHash = '0xSIMULATED_' + Date.now().toString(16);
                    stats.totalSynced++;
                    console.log(`[NftSync] 🔵 Simulated sync for ${address.slice(0, 10)}... (chain disabled)`);
                }
                upsertSyncState(address, CHAIN_ID, newScore, newTier, snapshotId, txHash || undefined);
                logSync(address, CHAIN_ID, oldScore, newScore, txHash, txStatus);
            }
            catch (err) {
                stats.totalErrors++;
                console.error(`[NftSync] Error processing ${address}:`, err.message);
            }
        }
    }
    catch (err) {
        console.error('[NftSync] Poll error:', err.message);
    }
    finally {
        stats.isRunning = false;
    }
}
// ─── Express Server ───────────────────────────────────────────────────────────
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'nft-sync',
        version: '0.1.0',
        chainEnabled: stats.chainEnabled,
        nftAddress,
        chainId: CHAIN_ID,
        pollIntervalMs: POLL_INTERVAL_MS,
        syncThreshold: SYNC_THRESHOLD,
    });
});
// GET /v1/nft-sync/status — overall sync stats
app.get('/v1/nft-sync/status', (_req, res) => {
    const syncStates = [];
    const stmtS = db.prepare('SELECT * FROM sync_state ORDER BY last_sync_at DESC');
    while (stmtS.step())
        syncStates.push(stmtS.getAsObject());
    stmtS.free();
    const recentLogs = [];
    const stmtL = db.prepare('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 20');
    while (stmtL.step())
        recentLogs.push(stmtL.getAsObject());
    stmtL.free();
    res.json({
        success: true,
        data: {
            stats,
            addresses: syncStates.map(s => ({
                address: s.address,
                chainId: s.chain_id,
                lastScore: s.last_score,
                lastTier: s.last_tier,
                lastSyncAt: s.last_sync_at,
                lastTxHash: s.last_tx_hash,
                syncCount: s.sync_count,
            })),
            recentLogs: recentLogs.map(l => ({
                address: l.address,
                oldScore: l.old_score,
                newScore: l.new_score,
                delta: l.delta,
                txHash: l.tx_hash,
                status: l.status,
                error: l.error,
                syncedAt: l.synced_at,
            })),
        },
    });
});
// POST /v1/nft-sync/trigger — manually trigger sync for a specific address
app.post('/v1/nft-sync/trigger', async (req, res) => {
    const { address, forceSync = false } = req.body;
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        res.status(400).json({ success: false, error: 'Invalid address' });
        return;
    }
    try {
        const snapRes = await fetch(`${REPUTATION_API}/v1/reputation/${CHAIN_ID}/${address}?forceRefresh=true`);
        if (!snapRes.ok) {
            res.status(502).json({ success: false, error: 'Failed to fetch reputation snapshot' });
            return;
        }
        const snapJson = await snapRes.json();
        if (!snapJson.success) {
            res.status(404).json({ success: false, error: 'No reputation data for address' });
            return;
        }
        const snapshot = snapJson.data;
        const newScore = Math.round(snapshot.scores.final);
        const newTier = snapshot.riskTier;
        const state = getSyncState(address, CHAIN_ID);
        const oldScore = state?.last_score ?? 0;
        const delta = Math.abs(newScore - oldScore);
        if (!forceSync && state && delta < SYNC_THRESHOLD && state.last_tier === newTier) {
            res.json({
                success: true,
                data: {
                    skipped: true,
                    reason: `Score delta (${delta}) below threshold (${SYNC_THRESHOLD}) and tier unchanged`,
                    currentScore: newScore,
                    currentTier: newTier,
                },
            });
            return;
        }
        let txHash = null;
        let txStatus = 'SIMULATED';
        let gasUsed = null;
        if (stats.chainEnabled) {
            const result = await syncAddressToChain(snapshot);
            if (result) {
                txHash = result.txHash;
                gasUsed = result.gasUsed;
                txStatus = 'SUCCESS';
                stats.totalSynced++;
            }
        }
        else {
            txHash = '0xSIMULATED_' + Date.now().toString(16);
            txStatus = 'SIMULATED';
            stats.totalSynced++;
        }
        upsertSyncState(address, CHAIN_ID, newScore, newTier, snapshot.snapshotId, txHash || undefined);
        logSync(address, CHAIN_ID, oldScore, newScore, txHash, txStatus);
        res.json({
            success: true,
            data: {
                address,
                oldScore,
                newScore,
                delta: newScore - oldScore,
                tier: newTier,
                txHash,
                gasUsed,
                status: txStatus,
                chainEnabled: stats.chainEnabled,
            },
        });
    }
    catch (err) {
        stats.totalErrors++;
        res.status(500).json({ success: false, error: err.message });
    }
});
// GET /v1/nft-sync/address/:addr — sync state for a specific address
app.get('/v1/nft-sync/address/:addr', (req, res) => {
    const address = req.params.addr.toLowerCase();
    const state = getSyncState(address, CHAIN_ID);
    const logs = [];
    const stmtH = db.prepare('SELECT * FROM sync_log WHERE address = ? AND chain_id = ? ORDER BY synced_at DESC LIMIT 10');
    stmtH.bind([address, CHAIN_ID]);
    while (stmtH.step())
        logs.push(stmtH.getAsObject());
    stmtH.free();
    res.json({
        success: true,
        data: {
            address,
            chainId: CHAIN_ID,
            syncState: state ? {
                lastScore: state.last_score,
                lastTier: state.last_tier,
                lastSyncAt: state.last_sync_at,
                lastTxHash: state.last_tx_hash,
                syncCount: state.sync_count,
            } : null,
            syncHistory: logs.map(l => ({
                oldScore: l.old_score,
                newScore: l.new_score,
                delta: l.delta,
                txHash: l.tx_hash,
                status: l.status,
                syncedAt: l.synced_at,
            })),
        },
    });
});
// // ─── Start ─────────────────────────────────────────────────────────────────
(async () => {
    db = await initDb();
    console.log('[NftSync] Database initialized');
    app.listen(PORT, () => {
        console.log(`[NftSync] Service started on port ${PORT}`);
        console.log(`[NftSync] Chain sync: ${stats.chainEnabled ? 'ENABLED' : 'SIMULATION MODE'}`);
        console.log(`[NftSync] NFT contract: ${nftAddress || '(not set)'}`);
        console.log(`[NftSync] Poll interval: ${POLL_INTERVAL_MS}ms | Sync threshold: ${SYNC_THRESHOLD} pts`);
        // Initial poll after 3s
        setTimeout(pollAndSync, 3000);
        // Recurring poll
        setInterval(pollAndSync, POLL_INTERVAL_MS);
    });
})();
