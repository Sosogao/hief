/**
 * HIEF Reputation Integration Tests
 *
 * Tests the complete "Data → Behavior → Revenue" loop:
 *
 *  1. ReputationPolicyAdapter  — dynamic Policy params per tier
 *  2. ReputationAgentAdapter   — tier-aware conversation context
 *  3. ReputationSolverAdapter  — tier-aware quote adjustments
 *  4. Full pipeline             — UNKNOWN vs ELITE user comparison
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

// ── Adapters under test ───────────────────────────────────────────────────────

import {
  ReputationPolicyAdapter,
  resetReputationPolicyAdapter,
} from '../../packages/policy/src/reputation/reputationPolicyAdapter';

import {
  ReputationAgentAdapter,
  resetReputationAgentAdapter,
} from '../../packages/agent/src/reputation/reputationAgentAdapter';

import {
  ReputationSolverAdapter,
  resetReputationSolverAdapter,
} from '../../packages/solver/src/reputation/reputationSolverAdapter';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mock = new MockAdapter(axios, { onNoMatch: 'throwException' });

const ADDR_UNKNOWN  = '0x0000000000000000000000000000000000000001';
const ADDR_NEWCOMER = '0x0000000000000000000000000000000000000002';
const ADDR_TRUSTED  = '0x0000000000000000000000000000000000000003';
const ADDR_ELITE    = '0x0000000000000000000000000000000000000004';
const ADDR_INACTIVE = '0x0000000000000000000000000000000000000005';

function mockReputation(address: string, tier: string, score: number, extra: object = {}) {
  mock.onGet(new RegExp(`/v1/reputation/${address}`)).reply(200, {
    tier,
    compositeScore: score,
    behaviorTags: tier === 'ELITE' ? ['RELIABLE', 'WHALE', 'ALPHA_HUNTER'] : [],
    metrics: { successRate: 0.98, daysSinceLastActive: 1, ...extra },
    ...extra,
  });
}

function mockReputationError(address: string) {
  mock.onGet(new RegExp(`/v1/reputation/${address}`)).networkError();
}

beforeEach(() => {
  mock.reset();
  resetReputationPolicyAdapter();
  resetReputationAgentAdapter();
  resetReputationSolverAdapter();

  mockReputation(ADDR_UNKNOWN,  'UNKNOWN',  50);
  mockReputation(ADDR_NEWCOMER, 'NEWCOMER', 150);
  mockReputation(ADDR_TRUSTED,  'TRUSTED',  450);
  mockReputation(ADDR_ELITE,    'ELITE',    800);
  mockReputation(ADDR_INACTIVE, 'TRUSTED',  300, { daysSinceLastActive: 120 });
});

afterAll(() => {
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. ReputationPolicyAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe('ReputationPolicyAdapter', () => {
  let adapter: ReputationPolicyAdapter;

  beforeEach(() => {
    adapter = new ReputationPolicyAdapter();
  });

  test('UNKNOWN tier gets strictest limits', async () => {
    const params = await adapter.getPolicyParams(ADDR_UNKNOWN);
    expect(params.tier).toBe('UNKNOWN');
    expect(params.maxSlippageBps).toBe(50);
    expect(params.maxFeeBps).toBe(100);
    expect(params.dailyLimitUsd).toBe(500);
    expect(params.requireSimulation).toBe(true);
  });

  test('NEWCOMER tier gets conservative limits', async () => {
    const params = await adapter.getPolicyParams(ADDR_NEWCOMER);
    expect(params.tier).toBe('NEWCOMER');
    expect(params.maxSlippageBps).toBe(100);
    expect(params.maxFeeBps).toBe(200);
    expect(params.dailyLimitUsd).toBe(2_000);
    expect(params.requireSimulation).toBe(true);
  });

  test('TRUSTED tier gets standard limits', async () => {
    const params = await adapter.getPolicyParams(ADDR_TRUSTED);
    expect(params.tier).toBe('TRUSTED');
    expect(params.maxSlippageBps).toBe(200);
    expect(params.maxFeeBps).toBe(300);
    expect(params.dailyLimitUsd).toBe(10_000);
    expect(params.requireSimulation).toBe(false);
  });

  test('ELITE tier gets highest limits', async () => {
    const params = await adapter.getPolicyParams(ADDR_ELITE);
    expect(params.tier).toBe('ELITE');
    expect(params.maxSlippageBps).toBe(500);
    expect(params.maxFeeBps).toBe(500);
    expect(params.dailyLimitUsd).toBe(100_000);
    expect(params.requireSimulation).toBe(false);
  });

  test('Network error falls back to UNKNOWN tier gracefully', async () => {
    mockReputationError(ADDR_UNKNOWN);
    const params = await adapter.getPolicyParams(ADDR_UNKNOWN);
    expect(params.tier).toBe('UNKNOWN');
    expect(params.maxSlippageBps).toBe(50);
  });

  test('ELITE tier has higher limits than TRUSTED', async () => {
    const elite   = await adapter.getPolicyParams(ADDR_ELITE);
    const trusted = await adapter.getPolicyParams(ADDR_TRUSTED);
    expect(elite.maxSlippageBps).toBeGreaterThan(trusted.maxSlippageBps);
    expect(elite.maxFeeBps).toBeGreaterThan(trusted.maxFeeBps);
    expect(elite.dailyLimitUsd).toBeGreaterThan(trusted.dailyLimitUsd);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ReputationAgentAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe('ReputationAgentAdapter', () => {
  let adapter: ReputationAgentAdapter;

  beforeEach(() => {
    adapter = new ReputationAgentAdapter();
  });

  test('UNKNOWN user gets risk warning in context', async () => {
    const ctx = await adapter.getUserContext(ADDR_UNKNOWN);
    expect(ctx.tier).toBe('UNKNOWN');
    expect(ctx.riskWarnings.length).toBeGreaterThan(0);
    expect(ctx.riskWarnings[0]).toMatch(/No on-chain history/i);
  });

  test('ELITE user gets tier badge and no risk warnings', async () => {
    const ctx = await adapter.getUserContext(ADDR_ELITE);
    expect(ctx.tier).toBe('ELITE');
    expect(ctx.tierBadge).toContain('Elite');
    expect(ctx.behaviorTags).toContain('RELIABLE');
    expect(ctx.riskWarnings.length).toBe(0);
  });

  test('Inactive TRUSTED user gets inactivity warning', async () => {
    const ctx = await adapter.getUserContext(ADDR_INACTIVE);
    expect(ctx.riskWarnings.some((w) => w.includes('inactive'))).toBe(true);
  });

  test('System prompt suffix contains tier-specific instructions', async () => {
    const unknownCtx = await adapter.getUserContext(ADDR_UNKNOWN);
    const eliteCtx   = await adapter.getUserContext(ADDR_ELITE);

    const unknownSuffix = adapter.buildSystemPromptSuffix(unknownCtx);
    const eliteSuffix   = adapter.buildSystemPromptSuffix(eliteCtx);

    // UNKNOWN gets verbose warnings
    expect(unknownSuffix).toMatch(/extra cautious/i);
    expect(unknownSuffix).toMatch(/daily limit/i);

    // ELITE gets streamlined flow
    expect(eliteSuffix).toMatch(/streamlined/i);
    expect(eliteSuffix).toMatch(/advanced options/i);
  });

  test('Confirmation header includes tier badge', async () => {
    const ctx = await adapter.getUserContext(ADDR_TRUSTED);
    const header = adapter.buildConfirmationHeader(ctx);
    expect(header).toContain('Trusted');
    expect(header).toContain('450');
  });

  test('Network error falls back to UNKNOWN context', async () => {
    mockReputationError('0x9999999999999999999999999999999999999999');
    const ctx = await adapter.getUserContext('0x9999999999999999999999999999999999999999');
    expect(ctx.tier).toBe('UNKNOWN');
    expect(ctx.riskWarnings.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ReputationSolverAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe('ReputationSolverAdapter', () => {
  let adapter: ReputationSolverAdapter;

  beforeEach(() => {
    adapter = new ReputationSolverAdapter();
  });

  test('ELITE user gets highest priority score', async () => {
    const params = await adapter.getSolverParams(ADDR_ELITE);
    expect(params.priorityScore).toBeGreaterThan(80);
    expect(params.settlementSpeed).toBe('FAST');
    expect(params.spreadMultiplier).toBeLessThan(1.0);
  });

  test('UNKNOWN user gets lowest priority score', async () => {
    const params = await adapter.getSolverParams(ADDR_UNKNOWN);
    expect(params.priorityScore).toBeLessThan(40);
    expect(params.settlementSpeed).toBe('CONSERVATIVE');
    expect(params.spreadMultiplier).toBeGreaterThan(1.0);
  });

  test('ELITE user gets reduced fee (spread multiplier < 1)', async () => {
    const params = await adapter.getSolverParams(ADDR_ELITE);
    const adjusted = adapter.applyReputationToQuote(params, {
      sellAmount: '1000000',
      buyAmount:  '1000000000000000000',
      feeAmount:  '10000',
    });
    const originalFee = BigInt('10000');
    const adjustedFee = BigInt(adjusted.adjustedFeeAmount);
    expect(adjustedFee).toBeLessThan(originalFee);
    expect(adjusted.note).toMatch(/elite/i);
  });

  test('UNKNOWN user gets increased fee (spread multiplier > 1)', async () => {
    const params = await adapter.getSolverParams(ADDR_UNKNOWN);
    const adjusted = adapter.applyReputationToQuote(params, {
      sellAmount: '1000000',
      buyAmount:  '1000000000000000000',
      feeAmount:  '10000',
    });
    const originalFee = BigInt('10000');
    const adjustedFee = BigInt(adjusted.adjustedFeeAmount);
    expect(adjustedFee).toBeGreaterThan(originalFee);
  });

  test('ELITE user gets buy amount bonus', async () => {
    const params = await adapter.getSolverParams(ADDR_ELITE);
    const adjusted = adapter.applyReputationToQuote(params, {
      sellAmount: '1000000',
      buyAmount:  '1000000000000000000',
      feeAmount:  '10000',
    });
    const originalBuy = BigInt('1000000000000000000');
    const adjustedBuy = BigInt(adjusted.adjustedBuyAmount);
    expect(adjustedBuy).toBeGreaterThan(originalBuy);
  });

  test('Priority score ordering: ELITE > TRUSTED > NEWCOMER > UNKNOWN', async () => {
    const elite    = await adapter.getSolverParams(ADDR_ELITE);
    const trusted  = await adapter.getSolverParams(ADDR_TRUSTED);
    const newcomer = await adapter.getSolverParams(ADDR_NEWCOMER);
    const unknown  = await adapter.getSolverParams(ADDR_UNKNOWN);

    expect(elite.priorityScore).toBeGreaterThan(trusted.priorityScore);
    expect(trusted.priorityScore).toBeGreaterThan(newcomer.priorityScore);
    expect(newcomer.priorityScore).toBeGreaterThan(unknown.priorityScore);
  });

  test('Solver selection hints contain all required fields', async () => {
    const params = await adapter.getSolverParams(ADDR_TRUSTED);
    const hints = adapter.buildSolverSelectionHints(params);
    expect(hints).toHaveProperty('priorityScore');
    expect(hints).toHaveProperty('settlementSpeed');
    expect(hints).toHaveProperty('requireSimulation');
    expect(hints).toHaveProperty('maxSlippageBps');
    expect(hints).toHaveProperty('tierLabel');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Full Pipeline: UNKNOWN vs ELITE comparison
// ─────────────────────────────────────────────────────────────────────────────

describe('Full Reputation Pipeline: UNKNOWN vs ELITE', () => {
  test('ELITE user gets better conditions across all three layers', async () => {
    const policyAdapter = new ReputationPolicyAdapter();
    const agentAdapter  = new ReputationAgentAdapter();
    const solverAdapter = new ReputationSolverAdapter();

    const [elitePolicy, unknownPolicy] = await Promise.all([
      policyAdapter.getPolicyParams(ADDR_ELITE),
      policyAdapter.getPolicyParams(ADDR_UNKNOWN),
    ]);

    const [eliteAgent, unknownAgent] = await Promise.all([
      agentAdapter.getUserContext(ADDR_ELITE),
      agentAdapter.getUserContext(ADDR_UNKNOWN),
    ]);

    const [eliteSolver, unknownSolver] = await Promise.all([
      solverAdapter.getSolverParams(ADDR_ELITE),
      solverAdapter.getSolverParams(ADDR_UNKNOWN),
    ]);

    // Policy: ELITE has higher limits
    expect(elitePolicy.maxSlippageBps).toBeGreaterThan(unknownPolicy.maxSlippageBps);
    expect(elitePolicy.dailyLimitUsd).toBeGreaterThan(unknownPolicy.dailyLimitUsd);
    expect(elitePolicy.requireSimulation).toBe(false);
    expect(unknownPolicy.requireSimulation).toBe(true);

    // Agent: ELITE has no risk warnings, UNKNOWN has warnings
    expect(eliteAgent.riskWarnings.length).toBe(0);
    expect(unknownAgent.riskWarnings.length).toBeGreaterThan(0);

    // Solver: ELITE has higher priority and lower spread
    expect(eliteSolver.priorityScore).toBeGreaterThan(unknownSolver.priorityScore);
    expect(eliteSolver.spreadMultiplier).toBeLessThan(unknownSolver.spreadMultiplier);
    expect(eliteSolver.settlementSpeed).toBe('FAST');
    expect(unknownSolver.settlementSpeed).toBe('CONSERVATIVE');
  });

  test('Reputation context is consistent across all layers for same address', async () => {
    const policyAdapter = new ReputationPolicyAdapter();
    const agentAdapter  = new ReputationAgentAdapter();
    const solverAdapter = new ReputationSolverAdapter();

    const [policy, agent, solver] = await Promise.all([
      policyAdapter.getPolicyParams(ADDR_TRUSTED),
      agentAdapter.getUserContext(ADDR_TRUSTED),
      solverAdapter.getSolverParams(ADDR_TRUSTED),
    ]);

    // All three layers agree on tier
    expect(policy.tier).toBe('TRUSTED');
    expect(agent.tier).toBe('TRUSTED');
    expect(solver.tier).toBe('TRUSTED');

    // All three layers agree on score
    expect(policy.score).toBe(450);
    expect(agent.score).toBe(450);
    expect(solver.score).toBe(450);
  });
});
