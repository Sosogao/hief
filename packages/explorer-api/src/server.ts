/**
 * HIEF Intent Explorer Backend API
 *
 * Aggregates data from:
 * - Intent Bus (SQLite DB): intent history, solutions, policy results
 * - Reputation API (HTTP): scores, leaderboard, behavior tags
 *
 * Exposes a unified REST API for the Explorer frontend.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { statsRouter } from './routes/stats';
import { intentsRouter } from './routes/intents';
import { addressRouter } from './routes/address';
import { activityRouter } from './routes/activity';
import { leaderboardRouter } from './routes/leaderboard';
import { portfolioRouter } from './routes/portfolio';

const app = express();
const PORT = parseInt(process.env.EXPLORER_API_PORT || process.env.PORT || '3006', 10);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[EXPLORER-API] ${req.method} ${req.path}`);
  next();
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'hief-explorer-api',
    version: '0.1.0',
    chainId: parseInt(process.env.CHAIN_ID || '99917', 10),
    uptime: process.uptime(),
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/v1/explorer/stats', statsRouter);
app.use('/v1/explorer/intents', intentsRouter);
app.use('/v1/explorer/address', addressRouter);
app.use('/v1/explorer/activity', activityRouter);
app.use('/v1/explorer/leaderboard', leaderboardRouter);
app.use('/v1/explorer/portfolio',  portfolioRouter);

// ─── Reputation proxy (for backward compat with existing frontend) ────────────
// Forward /v1/reputation/* to the Reputation API
import axios from 'axios';
const REP_URL = process.env.REPUTATION_API_URL || 'http://localhost:3005';

app.get('/v1/reputation/*', async (req: Request, res: Response) => {
  try {
    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const targetUrl = `${REP_URL}${req.path}${queryString}`;
    const upstream = await axios.get(targetUrl, { timeout: 5000 });
    res.json(upstream.data);
  } catch (err: any) {
    res.status(502).json({ success: false, error: 'Reputation API unavailable' });
  }
});

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[EXPLORER-API] Unhandled error:', err);
  res.status(500).json({ success: false, error: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[EXPLORER-API] HIEF Explorer API running on port ${PORT}`);
    console.log(`[EXPLORER-API] Chain ID: ${process.env.CHAIN_ID || '99917'}`);
    console.log(`[EXPLORER-API] Reputation API: ${REP_URL}`);
    console.log(`[EXPLORER-API] Bus DB: ${process.env.BUS_DB_PATH || '../../packages/bus/data/hief.db'}`);
  });
}

export { app };
