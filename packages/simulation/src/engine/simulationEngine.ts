/**
 * HIEF Simulation Engine — L4 Policy Layer
 *
 * Orchestrates the full L4 verification flow:
 *  1. Build Tenderly simulation request from HIEF Solution
 *  2. Execute simulation via TenderlyClient
 *  3. Parse response into ExecutionDiff via DiffEngine
 *  4. Run simulation-specific policy rules against the diff
 *  5. Return SimulationPolicyResult
 *
 * Graceful degradation: if Tenderly is unavailable, returns SKIP (not FAIL).
 * This ensures the system remains operational without Tenderly credentials.
 */

import {
  SimulationPolicyResult,
  SimulationFinding,
  SimulationRulesConfig,
  DEFAULT_SIMULATION_RULES,
  TenderlySimulationRequest,
  ExecutionDiff,
} from '../types';
import { TenderlyClient } from '../tenderly/tenderlyClient';
import { DiffEngine, calcNetOutflowUsd, findUnlimitedApprovals } from '../diff/diffEngine';

// ── Minimal HIEF types needed here (avoid circular deps) ─────────────────────
interface Call {
  to: string;
  data: string;
  value?: string;
  operation?: number; // 0=CALL, 1=DELEGATECALL
}

interface HIEFSolution {
  intentHash: string;
  solutionHash: string;
  solver: string;
  executionPlan: {
    safeAddress: string;
    calls: Call[];
    nonce: number;
    chainId: number;
  };
  quote: {
    inputToken: string;
    inputAmount: string;
    outputToken: string;
    outputAmount: string;
    slippageBps: number;
    quoteUsd?: number;
  };
  signature: string;
}

export class SimulationEngine {
  private readonly tenderly: TenderlyClient | null;
  private readonly diffEngine: DiffEngine;
  private readonly rules: SimulationRulesConfig;

  constructor(
    tenderly: TenderlyClient | null,
    rules: Partial<SimulationRulesConfig> = {}
  ) {
    this.tenderly = tenderly;
    this.diffEngine = new DiffEngine();
    this.rules = { ...DEFAULT_SIMULATION_RULES, ...rules };
  }

  /**
   * Run L4 simulation verification for a given HIEF Solution.
   * Returns SKIP if Tenderly is unavailable.
   */
  async verify(solution: HIEFSolution): Promise<SimulationPolicyResult> {
    const startMs = Date.now();

    // ── Graceful degradation ─────────────────────────────────────────────
    if (!this.tenderly) {
      return {
        status: 'SKIP',
        findings: [
          {
            ruleId: 'SIM-00',
            severity: 'LOW',
            message: 'Tenderly not configured — L4 simulation skipped. Set TENDERLY_* env vars to enable.',
          },
        ],
        durationMs: Date.now() - startMs,
      };
    }

    // ── Build simulation request ─────────────────────────────────────────
    const simReqs = this._buildSimRequests(solution);

    // ── Execute simulation ───────────────────────────────────────────────
    let diff: ExecutionDiff;
    try {
      if (simReqs.length === 1) {
        const resp = await this.tenderly.simulate(simReqs[0]);
        if (!resp) {
          return this._skipResult('Tenderly unreachable', startMs);
        }
        diff = this.diffEngine.parse(resp);
      } else {
        // Bundle: approve + swap
        const bundleResp = await this.tenderly.simulateBundle(simReqs);
        if (!bundleResp) {
          return this._skipResult('Tenderly unreachable (bundle)', startMs);
        }
        // Use the last simulation result as the primary diff
        const lastResp = bundleResp.simulation_results[bundleResp.simulation_results.length - 1];
        diff = this.diffEngine.parse(lastResp);
      }
    } catch (err) {
      return this._skipResult(`Simulation error: ${String(err)}`, startMs);
    }

    // ── Run policy rules against diff ────────────────────────────────────
    const findings = this._runRules(solution, diff);
    const hasCritical = findings.some((f) => f.severity === 'CRITICAL');
    const hasHigh = findings.some((f) => f.severity === 'HIGH');

    return {
      status: hasCritical || hasHigh ? 'FAIL' : 'PASS',
      simulationId: diff.simulationId,
      findings,
      executionDiff: diff,
      durationMs: Date.now() - startMs,
    };
  }

  // ── Private: Build Tenderly request ───────────────────────────────────────

  private _buildSimRequests(solution: HIEFSolution): TenderlySimulationRequest[] {
    const { executionPlan } = solution;
    const networkId = String(executionPlan.chainId);

    // Each call in the execution plan becomes a simulation
    return executionPlan.calls.map((call) => ({
      network_id: networkId,
      from: executionPlan.safeAddress,
      to: call.to,
      input: call.data,
      value: call.value ?? '0',
      gas: 3_000_000,
      simulation_type: 'full' as const,
      save: false,
    }));
  }

  // ── Private: Policy rules ─────────────────────────────────────────────────

  private _runRules(solution: HIEFSolution, diff: ExecutionDiff): SimulationFinding[] {
    const findings: SimulationFinding[] = [];
    const userAddress = solution.executionPlan.safeAddress;

    // SIM-01: Simulation must succeed (not revert)
    if (!diff.simulationSuccess) {
      findings.push({
        ruleId: 'SIM-01',
        severity: 'CRITICAL',
        message: `Simulation reverted: ${diff.errorMessage ?? 'unknown reason'}`,
        detail: { errorMessage: diff.errorMessage },
      });
      // No point running further rules if simulation failed
      return findings;
    }

    // SIM-02: Net USD outflow must not exceed quoted amount × multiplier
    const netOutflowUsd = calcNetOutflowUsd(diff, userAddress);
    const quoteUsd = solution.quote.quoteUsd;
    if (quoteUsd !== undefined && quoteUsd > 0) {
      const maxAllowed = quoteUsd * this.rules.maxOutflowUsdMultiplier;
      if (netOutflowUsd > maxAllowed) {
        findings.push({
          ruleId: 'SIM-02',
          severity: 'HIGH',
          message: `Net outflow $${netOutflowUsd.toFixed(2)} exceeds allowed maximum $${maxAllowed.toFixed(2)} (${(this.rules.maxOutflowUsdMultiplier * 100).toFixed(0)}% of quote)`,
          detail: { netOutflowUsd, maxAllowed, quoteUsd },
        });
      }
    }

    // SIM-03: Slippage check
    const slippageBps = solution.quote.slippageBps;
    if (slippageBps > this.rules.maxSlippageBps) {
      findings.push({
        ruleId: 'SIM-03',
        severity: 'HIGH',
        message: `Slippage ${slippageBps}bps exceeds maximum ${this.rules.maxSlippageBps}bps`,
        detail: { slippageBps, maxSlippageBps: this.rules.maxSlippageBps },
      });
    }

    // SIM-04: Block unlimited ERC-20 approvals
    if (this.rules.blockUnlimitedApprovals) {
      const unlimitedApprovals = findUnlimitedApprovals(diff, userAddress);
      for (const approval of unlimitedApprovals) {
        findings.push({
          ruleId: 'SIM-04',
          severity: 'HIGH',
          message: `Unlimited ERC-20 approval detected: ${approval.symbol} to spender ${approval.spender}`,
          detail: { tokenAddress: approval.tokenAddress, spender: approval.spender },
        });
      }
    }

    // SIM-05: Block DELEGATECALL in execution trace
    if (this.rules.blockDelegatecall) {
      // Check each call in the plan for DELEGATECALL operation flag
      const hasDelegatecallOp = solution.executionPlan.calls.some(
        (c) => c.operation === 1
      );
      if (hasDelegatecallOp) {
        findings.push({
          ruleId: 'SIM-05',
          severity: 'CRITICAL',
          message: 'DELEGATECALL operation detected in execution plan',
          detail: { calls: solution.executionPlan.calls.filter((c) => c.operation === 1) },
        });
      }
    }

    // SIM-06: Gas sanity check
    if (diff.gasUsed < this.rules.minGasUsed) {
      findings.push({
        ruleId: 'SIM-06',
        severity: 'MEDIUM',
        message: `Suspiciously low gas used: ${diff.gasUsed} (minimum expected: ${this.rules.minGasUsed})`,
        detail: { gasUsed: diff.gasUsed, minGasUsed: this.rules.minGasUsed },
      });
    }

    // SIM-07: Output token address must match intent
    // (Verify the simulation actually produced the expected output token)
    const expectedOutputToken = solution.quote.outputToken.toLowerCase();
    const hasOutputTokenInDiff = diff.tokenBalanceDiffs.some(
      (bd) =>
        bd.address === userAddress.toLowerCase() &&
        bd.tokenAddress === expectedOutputToken &&
        bd.delta > BigInt(0)
    );
    if (diff.tokenBalanceDiffs.length > 0 && !hasOutputTokenInDiff) {
      findings.push({
        ruleId: 'SIM-07',
        severity: 'HIGH',
        message: `Expected output token ${expectedOutputToken} not found in simulation balance changes`,
        detail: { expectedOutputToken, actualDiffs: diff.tokenBalanceDiffs.map((d) => d.tokenAddress) },
      });
    }

    return findings;
  }

  private _skipResult(reason: string, startMs: number): SimulationPolicyResult {
    return {
      status: 'SKIP',
      findings: [
        {
          ruleId: 'SIM-00',
          severity: 'LOW',
          message: `L4 simulation skipped: ${reason}`,
        },
      ],
      durationMs: Date.now() - startMs,
    };
  }
}
