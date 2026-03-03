/**
 * HIEF End-to-End Integration Test
 *
 * Tests the complete flow:
 * User Intent → Intent Bus → Policy Engine → Solver → Safe Proposal
 *
 * This test runs all three services in-process and verifies the full pipeline.
 */

import { ethers } from 'ethers';
import request from 'supertest';
import type { HIEFIntent, HIEFSolution, HIEFPolicyResult } from '@hief/common';
import { computeIntentHash, computeSolutionHash, computePlanHash } from '@hief/common';
import { validateSolution } from '../../packages/policy/src/engine/policyEngine';
import { getCowQuote, buildSolutionFromCowQuote } from '../../packages/solver/src/adapters/cowAdapter';
import { buildSafeTransaction } from '../../packages/solver/src/adapters/safeAdapter';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const COW_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';

function makeTestIntent(): HIEFIntent {
  return {
    intentVersion: '0.1',
    intentId: ethers.hexlify(ethers.randomBytes(32)),
    smartAccount: wallet.address,
    chainId: 8453,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    input: {
      token: USDC_BASE,
      amount: '1000000000', // 1000 USDC (6 decimals)
    },
    outputs: [
      {
        token: WETH_BASE,
        minAmount: '250000000000000000', // 0.25 WETH
      },
    ],
    constraints: { slippageBps: 50 },
    priorityFee: { token: 'HIEF', amount: '0' },
    policyRef: { policyVersion: 'v0.1' },
    signature: { type: 'EIP712_EOA', signer: wallet.address, sig: '0x1234' },
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('HIEF End-to-End: Intent → Policy → Solver → Safe', () => {
  let intent: HIEFIntent;
  let intentHash: string;
  let solution: HIEFSolution;
  let policyResult: HIEFPolicyResult;

  // ── Step 1: Intent Creation ────────────────────────────────────────────
  describe('Step 1: Intent Creation & Hash Computation', () => {
    it('should create a valid intent and compute its hash', () => {
      intent = makeTestIntent();
      intentHash = computeIntentHash(intent);

      expect(intentHash).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(intent.intentId).toBeTruthy();
      console.log(`[E2E] Intent created: ${intent.intentId}`);
      console.log(`[E2E] Intent hash: ${intentHash}`);
    });

    it('should produce deterministic hash for same intent', () => {
      const hash1 = computeIntentHash(intent);
      const hash2 = computeIntentHash(intent);
      expect(hash1).toBe(hash2);
    });
  });

  // ── Step 2: Solver Builds Solution ────────────────────────────────────
  describe('Step 2: Solver Builds Solution from CoW Quote', () => {
    it('should build a solution using mock CoW quote (no network call)', () => {
      // Mock CoW quote (in production, this comes from CoW API)
      const mockCowQuote = {
        sellToken: USDC_BASE,
        buyToken: WETH_BASE,
        sellAmount: '999000000', // 999 USDC after fee
        buyAmount: '265000000000000000', // 0.265 WETH
        feeAmount: '1000000', // 1 USDC fee
        validTo: Math.floor(Date.now() / 1000) + 300,
        appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
        kind: 'sell' as const,
        partiallyFillable: false,
        quoteId: 99999,
      };

      solution = buildSolutionFromCowQuote(intent, mockCowQuote, wallet.address);
      solution.intentHash = intentHash; // Bind to actual intentHash

      expect(solution.intentId).toBe(intent.intentId);
      expect(solution.intentHash).toBe(intentHash);
      expect(solution.quote.expectedOut).toBe('265000000000000000');
      expect(solution.executionPlan.calls).toHaveLength(2);

      const solutionHash = computeSolutionHash(solution);
      expect(solutionHash).toMatch(/^0x[0-9a-f]{64}$/i);

      console.log(`[E2E] Solution created: ${solution.solutionId}`);
      console.log(`[E2E] Expected output: ${solution.quote.expectedOut} WETH`);
      console.log(`[E2E] Fee: ${solution.quote.fee} USDC`);
    });

    it('should have approve call targeting USDC contract', () => {
      const approveCall = solution.executionPlan.calls[0];
      expect(approveCall.to.toLowerCase()).toBe(USDC_BASE.toLowerCase());
      expect(approveCall.data.startsWith('0x095ea7b3')).toBe(true);
      expect(approveCall.operation).toBe('CALL');
    });

    it('should have settlement call targeting CoW Settlement', () => {
      const settlementCall = solution.executionPlan.calls[1];
      expect(settlementCall.to.toLowerCase()).toBe(COW_SETTLEMENT.toLowerCase());
      expect(settlementCall.operation).toBe('CALL');
    });

    it('should NOT have unlimited approval (R7 compliance)', () => {
      const approveCall = solution.executionPlan.calls[0];
      const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
      const iface = new ethers.Interface(['function approve(address spender, uint256 amount)']);
      const decoded = iface.decodeFunctionData('approve', approveCall.data);
      const amount = BigInt(decoded[1].toString());
      expect(amount).not.toBe(MAX_UINT256);
      // Should be exactly 999000000 + 1000000 = 1000000000
      expect(amount).toBe(1000000000n);
    });
  });

  // ── Step 3: Policy Validation ──────────────────────────────────────────
  describe('Step 3: Policy Engine Validates Solution', () => {
    it('should PASS policy validation for a valid solution', async () => {
      policyResult = await validateSolution(intent, solution);

      // Should pass or warn (R8 may warn about non-whitelisted addresses)
      expect(['PASS', 'WARN']).toContain(policyResult.status);
      expect(policyResult.findings.filter((f) => f.severity === 'CRITICAL')).toHaveLength(0);
      expect(policyResult.findings.filter((f) => f.severity === 'HIGH')).toHaveLength(0);

      console.log(`[E2E] Policy result: ${policyResult.status}`);
      policyResult.summary.forEach((s) => console.log(`[E2E]   ${s}`));
    });

    it('should have intentHash bound in policy result', () => {
      expect(policyResult.intentHash).toBe(intentHash);
    });

    it('should FAIL policy for expired intent', async () => {
      const expiredIntent = { ...intent, deadline: Math.floor(Date.now() / 1000) - 100 };
      const result = await validateSolution(expiredIntent, solution);
      expect(result.status).toBe('FAIL');
      expect(result.findings.some((f) => f.ruleId === 'R1')).toBe(true);
    });

    it('should FAIL policy for DELEGATECALL', async () => {
      const maliciousSolution: HIEFSolution = {
        ...solution,
        executionPlan: {
          calls: [{
            to: COW_SETTLEMENT,
            value: '0',
            data: '0xdeadbeef',
            operation: 'DELEGATECALL',
          }],
        },
      };
      const result = await validateSolution(intent, maliciousSolution);
      expect(result.status).toBe('FAIL');
      expect(result.findings.some((f) => f.ruleId === 'R11')).toBe(true);
    });

    it('should FAIL policy for excessive fee', async () => {
      const greedySolution: HIEFSolution = {
        ...solution,
        quote: {
          ...solution.quote,
          expectedOut: '100',
          fee: '50', // 33% fee
        },
      };
      const result = await validateSolution(intent, greedySolution);
      expect(result.status).toBe('FAIL');
      expect(result.findings.some((f) => f.ruleId === 'R4')).toBe(true);
    });
  });

  // ── Step 4: Safe Transaction Building ─────────────────────────────────
  describe('Step 4: Safe Adapter Builds Transaction Proposal', () => {
    it('should build a Safe transaction with planHash binding', async () => {
      const safeResult = await buildSafeTransaction(
        intent,
        solution,
        policyResult,
        wallet.address, // mock safe address
        8453
      );

      expect(safeResult.safeTxHash).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(safeResult.planHash).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(safeResult.safeAddress).toBe(wallet.address);
      expect(safeResult.transaction.operation).toBe(1); // MultiSend = DELEGATECALL

      console.log(`[E2E] Safe tx hash: ${safeResult.safeTxHash}`);
      console.log(`[E2E] Plan hash: ${safeResult.planHash}`);
    });

    it('should have planHash that binds solution to intentHash', async () => {
      const safeResult = await buildSafeTransaction(
        intent,
        solution,
        policyResult,
        wallet.address,
        8453
      );

      // Verify planHash is deterministic
      const expectedPlanHash = computePlanHash(solution, intentHash);
      expect(safeResult.planHash).toBe(expectedPlanHash);
    });

    it('should include human-readable summary', async () => {
      const safeResult = await buildSafeTransaction(
        intent,
        solution,
        policyResult,
        wallet.address,
        8453
      );

      expect(safeResult.humanSummary.length).toBeGreaterThan(0);
      // Summary should contain status indicator
      const summaryText = safeResult.humanSummary.join(' ');
      expect(summaryText).toMatch(/PASS|WARN/);
    });
  });

  // ── Step 5: Full Pipeline Summary ─────────────────────────────────────
  describe('Step 5: Full Pipeline Integrity Check', () => {
    it('should maintain data integrity across the entire pipeline', async () => {
      // 1. Intent
      const testIntent = makeTestIntent();
      const testIntentHash = computeIntentHash(testIntent);

      // 2. Solution
      const mockQuote = {
        sellToken: USDC_BASE,
        buyToken: WETH_BASE,
        sellAmount: '999000000',
        buyAmount: '260000000000000000',
        feeAmount: '1000000',
        validTo: Math.floor(Date.now() / 1000) + 300,
        appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
        kind: 'sell' as const,
        partiallyFillable: false,
      };
      const testSolution = buildSolutionFromCowQuote(testIntent, mockQuote, wallet.address);
      testSolution.intentHash = testIntentHash;

      // 3. Policy
      const testPolicyResult = await validateSolution(testIntent, testSolution);
      expect(['PASS', 'WARN']).toContain(testPolicyResult.status);
      expect(testPolicyResult.intentHash).toBe(testIntentHash);

      // 4. Safe
      const testSafeResult = await buildSafeTransaction(
        testIntent,
        testSolution,
        testPolicyResult,
        wallet.address,
        8453
      );

      // Verify the full chain of trust:
      // intentHash → solutionHash → planHash
      const testSolutionHash = computeSolutionHash(testSolution);
      const testPlanHash = computePlanHash(testSolution, testIntentHash);

      expect(testSafeResult.planHash).toBe(testPlanHash);
      expect(testPolicyResult.intentHash).toBe(testIntentHash);
      expect(testSolution.intentHash).toBe(testIntentHash);

      console.log('\n[E2E] ✅ Full pipeline integrity verified:');
      console.log(`  Intent ID:     ${testIntent.intentId}`);
      console.log(`  Intent Hash:   ${testIntentHash}`);
      console.log(`  Solution ID:   ${testSolution.solutionId}`);
      console.log(`  Solution Hash: ${testSolutionHash}`);
      console.log(`  Plan Hash:     ${testPlanHash}`);
      console.log(`  Safe Tx Hash:  ${testSafeResult.safeTxHash}`);
      console.log(`  Policy Status: ${testPolicyResult.status}`);
    });
  });
});
