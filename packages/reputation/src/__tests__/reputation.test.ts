/**
 * HIEF Reputation Layer Tests
 *
 * Tests cover:
 * - ScoringEngine: four-dimensional scoring, decay, tags, tiers
 * - ReputationStore: metrics CRUD, snapshot caching, event processing
 * - API: all endpoints via supertest
 */

import { ScoringEngine } from '../engine/scoringEngine';
import { ReputationStore } from '../engine/reputationStore';
import { app, initServer } from '../api/server';
import type { AddressMetrics } from '../types';
import request from 'supertest';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

const ADDR_A = '0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA';
const ADDR_B = '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
const CHAIN_BASE = 8453;

function makeMetrics(overrides: Partial<AddressMetrics> = {}): AddressMetrics {
  return {
    ...ScoringEngine.emptyMetrics(ADDR_A, CHAIN_BASE),
    totalIntentsSubmitted: 100,
    totalIntentsSucceeded: 95,
    totalIntentsFailed: 3,
    totalIntentsExpired: 2,
    totalVolumeUSD: 50000,
    largestSingleTradeUSD: 10000,
    successRate: 0.95,
    avgSlippageBps: 15,
    avgExecutionTimeMs: 800,
    alphaScoreSum: 450,
    alphaTradeCount: 10,
    uniqueTokensTraded: 12,
    uniqueSkillsUsed: 4,
    uniqueSolversUsed: 3,
    uniqueChainsUsed: 2,
    firstIntentAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
    lastIntentAt: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 day ago
    activeWeeks: 12,
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ─── ScoringEngine Tests ──────────────────────────────────────────────────────

describe('ScoringEngine', () => {
  let engine: ScoringEngine;

  beforeEach(() => {
    engine = new ScoringEngine();
  });

  test('computes correct success score for 95% success rate', () => {
    const metrics = makeMetrics();
    const scores = engine.computeScores(metrics);
    // failRate = (3+2)/100 = 0.05, S_score = (1-0.05)*1000 = 950
    expect(scores.successScore).toBe(950);
  });

  test('computes volume score with log compression', () => {
    const metrics = makeMetrics({ totalVolumeUSD: 50000 });
    const scores = engine.computeScores(metrics);
    // V_score = log10(50001) * 100 ≈ 469
    expect(scores.volumeScore).toBeGreaterThan(400);
    expect(scores.volumeScore).toBeLessThanOrEqual(1000);
  });

  test('volume score is capped at 1000', () => {
    const metrics = makeMetrics({ totalVolumeUSD: 1e12 }); // $1 trillion
    const scores = engine.computeScores(metrics);
    expect(scores.volumeScore).toBe(1000);
  });

  test('computes alpha score from alphaScoreSum', () => {
    const metrics = makeMetrics({ alphaScoreSum: 450 });
    const scores = engine.computeScores(metrics);
    // A_score = log(1+450)*50 ≈ 305
    expect(scores.alphaScore).toBeGreaterThan(0);
    expect(scores.alphaScore).toBeLessThanOrEqual(1000);
  });

  test('computes diversity score from skills and tokens', () => {
    const metrics = makeMetrics({ uniqueSkillsUsed: 4, uniqueTokensTraded: 12, uniqueChainsUsed: 2 });
    const scores = engine.computeScores(metrics);
    // D_score = 4*20 + 12*5 + 2*30 = 80+60+60 = 200
    expect(scores.diversityScore).toBe(200);
  });

  test('applies time decay for inactive address', () => {
    const now = Date.now();
    const metrics = makeMetrics({
      lastIntentAt: now - 180 * 24 * 60 * 60 * 1000, // 180 days ago = half-life
    });
    const scores = engine.computeScores(metrics, now);
    // After 180 days (half-life), decay = 0.5
    expect(scores.decayFactor).toBeCloseTo(0.5, 1);
    expect(scores.final).toBeLessThan(scores.composite);
  });

  test('decay factor never goes below minDecayFactor', () => {
    const now = Date.now();
    const metrics = makeMetrics({
      lastIntentAt: now - 3650 * 24 * 60 * 60 * 1000, // 10 years ago
    });
    const scores = engine.computeScores(metrics, now);
    expect(scores.decayFactor).toBeGreaterThanOrEqual(0.1);
  });

  test('new address with no activity has very low final score (decay applied)', () => {
    const metrics = ScoringEngine.emptyMetrics(ADDR_B, CHAIN_BASE);
    const scores = engine.computeScores(metrics);
    // Empty address: S_score=1000 (0 fail), V=0, A=0, D=0
    // composite = 0.35*1000 = 350, but decay is minDecayFactor (0.1) due to no activity
    // final = 350 * 0.1 = 35 (approximately)
    expect(scores.final).toBeLessThan(100);
    // decay = 0.5^(365/180) ≈ 0.245, well below 1.0
    expect(scores.decayFactor).toBeLessThan(0.3);
  });

  test('assigns RELIABLE tag for >95% success rate with 10+ intents', () => {
    const metrics = makeMetrics({ successRate: 0.97, totalIntentsSubmitted: 20 });
    const tags = engine.computeTags(metrics);
    expect(tags).toContain('RELIABLE');
  });

  test('assigns WHALE tag for large single trade', () => {
    const metrics = makeMetrics({ largestSingleTradeUSD: 150000 });
    const tags = engine.computeTags(metrics);
    expect(tags).toContain('WHALE');
  });

  test('assigns DIVERSIFIED tag for >10 unique tokens', () => {
    const metrics = makeMetrics({ uniqueTokensTraded: 15 });
    const tags = engine.computeTags(metrics);
    expect(tags).toContain('DIVERSIFIED');
  });

  test('assigns MULTI_CHAIN tag for >2 chains', () => {
    const metrics = makeMetrics({ uniqueChainsUsed: 3 });
    const tags = engine.computeTags(metrics);
    expect(tags).toContain('MULTI_CHAIN');
  });

  test('assigns LOW_SLIPPAGE_OPTIMIZER tag for low avg slippage', () => {
    const metrics = makeMetrics({ avgSlippageBps: 10, totalIntentsSucceeded: 10 });
    const tags = engine.computeTags(metrics);
    expect(tags).toContain('LOW_SLIPPAGE_OPTIMIZER');
  });

  test('maps score to correct risk tier', () => {
    expect(engine.computeRiskTier(0)).toBe('UNKNOWN');
    expect(engine.computeRiskTier(50)).toBe('LOW');
    expect(engine.computeRiskTier(200)).toBe('STANDARD');
    // trusted tier: [300, 600), elite tier: [600, ∞)
    expect(engine.computeRiskTier(400)).toBe('TRUSTED');
    expect(engine.computeRiskTier(599)).toBe('TRUSTED');
    expect(engine.computeRiskTier(600)).toBe('ELITE');
    expect(engine.computeRiskTier(900)).toBe('ELITE');
  });

  test('computeSnapshot returns valid snapshot with all fields', () => {
    const metrics = makeMetrics();
    const snapshot = engine.computeSnapshot(metrics);
    expect(snapshot.address).toBe(ADDR_A.toLowerCase());
    expect(snapshot.chainId).toBe(CHAIN_BASE);
    expect(snapshot.snapshotId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(snapshot.scores.final).toBeGreaterThan(0);
    expect(snapshot.behaviorTags.length).toBeGreaterThan(0);
    expect(snapshot.riskTier).not.toBe('UNKNOWN');
    expect(snapshot.validUntil).toBeGreaterThan(snapshot.computedAt);
  });

  test('applyIntentEvent increments metrics correctly', () => {
    const metrics = ScoringEngine.emptyMetrics(ADDR_A, CHAIN_BASE);
    const updated = engine.applyIntentEvent(metrics, {
      status: 'SUCCESS',
      inputAmountUSD: 1000,
      alphaScore: 60,
      actualSlippageBps: 25,
    });
    expect(updated.totalIntentsSubmitted).toBe(1);
    expect(updated.totalIntentsSucceeded).toBe(1);
    expect(updated.totalVolumeUSD).toBe(1000);
    expect(updated.alphaScoreSum).toBe(60);
    expect(updated.successRate).toBe(1.0);
  });

  test('applyIntentEvent handles FAILED status', () => {
    const metrics = ScoringEngine.emptyMetrics(ADDR_A, CHAIN_BASE);
    const updated = engine.applyIntentEvent(metrics, {
      status: 'FAILED',
      inputAmountUSD: 500,
    });
    expect(updated.totalIntentsFailed).toBe(1);
    expect(updated.successRate).toBe(0);
  });
});

// ─── ReputationStore Tests ────────────────────────────────────────────────────

describe('ReputationStore', () => {
  let store: ReputationStore;

  beforeEach(async () => {
    store = new ReputationStore(new ScoringEngine());
    await store.init();
  });

  test('returns empty metrics for unknown address', () => {
    const metrics = store.getMetrics(ADDR_A, CHAIN_BASE);
    expect(metrics.totalIntentsSubmitted).toBe(0);
    expect(metrics.address).toBe(ADDR_A.toLowerCase());
  });

  test('saves and retrieves metrics', () => {
    const metrics = makeMetrics();
    store.saveMetrics(metrics);
    const retrieved = store.getMetrics(ADDR_A, CHAIN_BASE);
    expect(retrieved.totalIntentsSubmitted).toBe(100);
    expect(retrieved.totalVolumeUSD).toBe(50000);
  });

  test('saves and retrieves intent records', () => {
    store.saveIntentRecord({
      intentId: '0xabc123',
      address: ADDR_A,
      chainId: CHAIN_BASE,
      intentType: 'SWAP',
      inputToken: '0xUSDC',
      outputToken: '0xETH',
      inputAmountUSD: 1000,
      status: 'SUCCESS',
      submittedAt: Date.now(),
    });
    const history = store.getIntentHistory(ADDR_A, CHAIN_BASE);
    expect(history).toHaveLength(1);
    expect(history[0].intentId).toBe('0xabc123');
    expect(history[0].status).toBe('SUCCESS');
  });

  test('processIntentEvent updates metrics and returns snapshot', () => {
    const snapshot = store.processIntentEvent({
      intentId: '0xevent001',
      address: ADDR_A,
      chainId: CHAIN_BASE,
      intentType: 'SWAP',
      inputToken: '0xUSDC',
      outputToken: '0xETH',
      inputAmountUSD: 5000,
      status: 'SUCCESS',
      submittedAt: Date.now(),
      alphaScore: 75,
    });
    expect(snapshot.address).toBe(ADDR_A.toLowerCase());
    expect(snapshot.scores.final).toBeGreaterThan(0);
    expect(snapshot.metrics.totalIntents).toBe(1);
  });

  test('getOrComputeSnapshot returns cached snapshot on second call', async () => {
    // First call: compute
    const { cached: c1 } = await store.getOrComputeSnapshot(ADDR_A, CHAIN_BASE);
    expect(c1).toBe(false);

    // Second call: from cache
    const { cached: c2 } = await store.getOrComputeSnapshot(ADDR_A, CHAIN_BASE);
    expect(c2).toBe(true);
  });

  test('forceRefresh bypasses cache', async () => {
    await store.getOrComputeSnapshot(ADDR_A, CHAIN_BASE);
    const { cached } = await store.getOrComputeSnapshot(ADDR_A, CHAIN_BASE, true);
    expect(cached).toBe(false);
  });

  test('getLeaderboard returns sorted results', () => {
    // Add two addresses with different scores
    store.saveMetrics(makeMetrics({ address: ADDR_A.toLowerCase(), totalVolumeUSD: 100000 }));
    store.saveMetrics(makeMetrics({ address: ADDR_B.toLowerCase(), totalVolumeUSD: 1000 }));
    const leaderboard = store.getLeaderboard(CHAIN_BASE, 10);
    expect(leaderboard.length).toBeGreaterThanOrEqual(2);
    expect(leaderboard[0].score).toBeGreaterThanOrEqual(leaderboard[1].score);
  });
});

// ─── API Tests ────────────────────────────────────────────────────────────────

describe('Reputation API', () => {
  beforeAll(async () => {
    await initServer();
  });

  test('GET /v1/reputation/health returns ok', async () => {
    const res = await request(app).get('/v1/reputation/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /v1/reputation/:chainId/:address returns snapshot', async () => {
    const res = await request(app).get(`/v1/reputation/${CHAIN_BASE}/${ADDR_A}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.address).toBe(ADDR_A.toLowerCase());
    expect(res.body.data.scores).toBeDefined();
    expect(res.body.meta.source).toBeDefined();
  });

  test('GET /v1/reputation/:chainId/:address returns 400 for invalid address', async () => {
    const res = await request(app).get(`/v1/reputation/${CHAIN_BASE}/not-an-address`);
    expect(res.status).toBe(400);
  });

  test('GET /v1/reputation/:chainId/:address/history returns empty array for new address', async () => {
    const res = await request(app).get(`/v1/reputation/${CHAIN_BASE}/${ADDR_B}/history`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  test('POST /v1/reputation/events ingests event and updates score', async () => {
    const res = await request(app)
      .post('/v1/reputation/events')
      .send({
        intentId: '0xtest001',
        address: ADDR_A,
        chainId: CHAIN_BASE,
        status: 'SUCCESS',
        inputAmountUSD: 2000,
        intentType: 'SWAP',
        inputToken: '0xUSDC',
        outputToken: '0xETH',
        alphaScore: 80,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.newScore).toBeGreaterThan(0);
    expect(res.body.data.riskTier).toBeDefined();
  });

  test('POST /v1/reputation/events returns 400 for missing fields', async () => {
    const res = await request(app)
      .post('/v1/reputation/events')
      .send({ intentId: '0xtest002' }); // missing required fields
    expect(res.status).toBe(400);
  });

  test('GET /v1/reputation/:chainId/leaderboard returns array', async () => {
    const res = await request(app).get(`/v1/reputation/${CHAIN_BASE}/leaderboard`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('score increases after successful intent event', async () => {
    // Get initial score
    const before = await request(app).get(`/v1/reputation/${CHAIN_BASE}/${ADDR_B}`);
    const scoreBefore = before.body.data.scores.final;

    // Ingest a successful event
    await request(app)
      .post('/v1/reputation/events')
      .send({
        intentId: '0xtest003',
        address: ADDR_B,
        chainId: CHAIN_BASE,
        status: 'SUCCESS',
        inputAmountUSD: 10000,
        intentType: 'SWAP',
        inputToken: '0xUSDC',
        outputToken: '0xETH',
      });

    // Get updated score (force refresh)
    const after = await request(app).get(`/v1/reputation/${CHAIN_BASE}/${ADDR_B}?refresh=true`);
    const scoreAfter = after.body.data.scores.final;

    expect(scoreAfter).toBeGreaterThan(scoreBefore);
  });
});
