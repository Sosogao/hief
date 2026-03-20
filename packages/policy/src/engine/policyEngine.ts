import type { HIEFIntent, HIEFSolution, HIEFSessionGrant, HIEFPolicyResult, PolicyFinding, ExecutionDiff } from '@hief/common';
import { computeIntentHash } from '@hief/common';
import { runStaticRules, checkSessionKeyConstraints } from '../rules/staticRules';
import { runL4Simulation } from '../simulation/forkSimulator';
import { getReputationPolicyAdapter, DynamicPolicyParams } from '../reputation/reputationPolicyAdapter';
import { runReputationAwareRules } from '../reputation/reputationAwareRules';

function makeResult(
  intent: HIEFIntent,
  solution: HIEFSolution | null,
  status: HIEFPolicyResult['status'],
  findings: PolicyFinding[],
  summary: string[],
  executionDiff?: ExecutionDiff,
  reputationContext?: { tier: string; score: number; appliedParams: DynamicPolicyParams }
): HIEFPolicyResult {
  return {
    policyResultVersion: '0.1',
    policyRef: { policyVersion: 'v0.1' },
    intentHash: computeIntentHash(intent),
    solutionId: solution?.solutionId,
    status,
    findings,
    riskTags: findings.filter((f) => f.severity === 'CRITICAL').map((f) => f.ruleId),
    summary,
    executionDiff,
    reputationContext,
    timestamp: Math.floor(Date.now() / 1000),
  } as HIEFPolicyResult & { reputationContext?: unknown };
}

// ── Shared L4 simulation helper ───────────────────────────────────────────────

async function runL4(
  solution: HIEFSolution,
  findings: PolicyFinding[],
  summary: string[]
): Promise<boolean> {
  let simFailed = false;
  try {
    const simResult = await runL4Simulation(solution);

    if (simResult.status === 'FAIL') {
      simFailed = true;
      for (const f of simResult.findings) {
        findings.push({
          ruleId: f.ruleId,
          severity: f.severity as PolicyFinding['severity'],
          message: f.message,
          evidence: f.detail,
        });
      }
      summary.push(`❌ FAIL: L4 simulation found ${simResult.findings.length} violation(s)`);
    } else if (simResult.status === 'SKIP') {
      findings.push({
        ruleId: 'SIM-00',
        severity: 'LOW',
        message: simResult.findings[0]?.message ?? 'L4 simulation skipped (Tenderly not configured)',
      });
    }
  } catch (err: any) {
    console.error('[POLICY] Simulation error:', err.message);
    findings.push({
      ruleId: 'SIM-00',
      severity: 'LOW',
      message: `Fork simulation unavailable: ${err.message}`,
    });
  }
  return simFailed;
}

// ── Standard validation (no reputation context) ───────────────────────────────

export interface SessionContext {
  grant: HIEFSessionGrant;
  txUsdValue: number; // Estimated USD value of this transaction
}

export async function validateSolution(
  intent: HIEFIntent,
  solution: HIEFSolution,
  sessionContext?: SessionContext,
): Promise<HIEFPolicyResult> {
  const findings: PolicyFinding[] = [];
  const summary: string[] = [];

  // Phase 1: Static Rules
  const { results: ruleResults, hasCriticalFailure, hasHighFailure } = runStaticRules(intent, solution);

  for (const result of ruleResults) {
    if (!result.passed && result.finding) {
      findings.push({
        ruleId: result.finding.ruleId,
        severity: result.finding.severity,
        message: result.finding.message,
        evidence: result.finding.field ? { field: result.finding.field } : undefined,
      });
    }
  }

  // Phase 1b: R13 Session Key Constraints (only when executing via session key)
  let sessionKeyFailed = false;
  if (sessionContext) {
    const r13 = checkSessionKeyConstraints(intent, sessionContext.grant, sessionContext.txUsdValue);
    if (!r13.passed && r13.finding) {
      findings.push({
        ruleId: r13.finding.ruleId,
        severity: r13.finding.severity,
        message: r13.finding.message,
        evidence: r13.finding.field ? { field: r13.finding.field } : undefined,
      });
      sessionKeyFailed = r13.severity === 'CRITICAL' || r13.severity === 'HIGH';
    }
  }

  if (hasCriticalFailure || sessionKeyFailed) {
    const criticalFindings = findings.filter((f) => f.severity === 'CRITICAL');
    summary.push(`❌ FAIL: ${criticalFindings.length} critical rule(s) violated`);
    criticalFindings.forEach((f) => summary.push(`  • [${f.ruleId}] ${f.message}`));
    return makeResult(intent, solution, 'FAIL', findings, summary);
  }

  // Phase 2: Fork Simulation
  const simFailed = await runL4(solution, findings, summary);
  if (simFailed) {
    return makeResult(intent, solution, 'FAIL', findings, summary);
  }

  // Determine final status
  const hasAnyFailure = hasCriticalFailure || hasHighFailure || simFailed;
  const hasMediumWarnings = findings.some((f) => f.severity === 'MEDIUM');
  const status: HIEFPolicyResult['status'] = hasAnyFailure ? 'FAIL' : hasMediumWarnings ? 'WARN' : 'PASS';

  if (status === 'PASS') {
    summary.push(`✅ PASS: All ${ruleResults.length} rules passed`);
    summary.push(`Swap ${intent.input.amount} ${intent.input.token} → min ${intent.outputs[0]?.minAmount} ${intent.outputs[0]?.token}`);
    summary.push(`Expected output: ${solution.quote.expectedOut}`);
    summary.push(`Fee: ${solution.quote.fee}`);
  } else if (status === 'WARN') {
    summary.push(`⚠️ WARN: ${findings.length} warning(s) found`);
    findings.forEach((f) => summary.push(`  • [${f.ruleId}] ${f.message}`));
  } else {
    summary.push(`❌ FAIL: ${findings.filter((f) => ['CRITICAL', 'HIGH'].includes(f.severity)).length} issue(s) found`);
    findings.forEach((f) => summary.push(`  • [${f.ruleId}] ${f.message}`));
  }

  return makeResult(intent, solution, status, findings, summary);
}

// ── Reputation-Aware validation ───────────────────────────────────────────────

/**
 * Validate a solution with dynamic per-user policy parameters derived
 * from the user's reputation tier.
 *
 * Key differences from validateSolution():
 *  - R4 (fee cap) and R5 (slippage cap) thresholds are adjusted per tier
 *  - R_DAILY_LIMIT is enforced based on tier
 *  - Risk warnings are surfaced as LOW findings
 *  - reputationContext is attached to the result for transparency
 *
 * Security rules (R1, R2, R6, R7, R10, R11, R12) are NEVER relaxed.
 */
export async function validateSolutionWithReputation(
  intent: HIEFIntent,
  solution: HIEFSolution,
  userAddress: string
): Promise<HIEFPolicyResult> {
  const findings: PolicyFinding[] = [];
  const summary: string[] = [];

  // Fetch reputation params (graceful degradation to UNKNOWN tier)
  const adapter = getReputationPolicyAdapter();
  const params = await adapter.getPolicyParams(userAddress);

  summary.push(`[REP] User ${userAddress.slice(0, 8)}... | Tier: ${params.tier} | Score: ${params.score}`);
  summary.push(`[REP] Applied limits — Slippage: ${params.maxSlippageBps}bps | Fee: ${params.maxFeeBps}bps | Daily: $${params.dailyLimitUsd.toLocaleString()}`);

  // Phase 1: Reputation-Aware Static Rules
  const {
    results: ruleResults,
    reputationFindings,
    hasCriticalFailure,
    hasHighFailure,
    appliedParams,
  } = runReputationAwareRules(intent, solution, params);

  for (const result of ruleResults) {
    if (!result.passed && result.finding) {
      findings.push({
        ruleId: result.finding.ruleId,
        severity: result.finding.severity,
        message: result.finding.message,
        evidence: result.finding.field ? { field: result.finding.field } : undefined,
      });
    }
  }

  // Add reputation-specific findings (daily limit, risk warnings)
  findings.push(...reputationFindings);

  if (hasCriticalFailure) {
    const criticalFindings = findings.filter((f) => f.severity === 'CRITICAL');
    summary.push(`❌ FAIL: ${criticalFindings.length} critical rule(s) violated`);
    criticalFindings.forEach((f) => summary.push(`  • [${f.ruleId}] ${f.message}`));
    return makeResult(intent, solution, 'FAIL', findings, summary, undefined, {
      tier: params.tier,
      score: params.score,
      appliedParams,
    });
  }

  // Phase 2: Fork Simulation (skip if tier allows and no high failures)
  let simFailed = false;
  if (params.requireSimulation || hasHighFailure) {
    simFailed = await runL4(solution, findings, summary);
    if (simFailed) {
      return makeResult(intent, solution, 'FAIL', findings, summary, undefined, {
        tier: params.tier,
        score: params.score,
        appliedParams,
      });
    }
  } else {
    summary.push(`[REP] L4 simulation skipped for ${params.tier} tier (score: ${params.score})`);
  }

  // Determine final status
  const hasAnyFailure = hasCriticalFailure || hasHighFailure || simFailed;
  const hasMediumWarnings = findings.some((f) => f.severity === 'MEDIUM');
  const status: HIEFPolicyResult['status'] = hasAnyFailure ? 'FAIL' : hasMediumWarnings ? 'WARN' : 'PASS';

  if (status === 'PASS') {
    summary.push(`✅ PASS: All rules passed (${params.tier} tier policy applied)`);
    summary.push(`Swap ${intent.input.amount} ${intent.input.token} → min ${intent.outputs[0]?.minAmount} ${intent.outputs[0]?.token}`);
    summary.push(`Expected output: ${solution.quote.expectedOut}`);
    summary.push(`Fee: ${solution.quote.fee}`);
  } else if (status === 'WARN') {
    summary.push(`⚠️ WARN: ${findings.filter((f) => f.severity !== 'LOW').length} warning(s) found`);
    findings.filter((f) => f.severity !== 'LOW').forEach((f) => summary.push(`  • [${f.ruleId}] ${f.message}`));
  } else {
    summary.push(`❌ FAIL: ${findings.filter((f) => ['CRITICAL', 'HIGH'].includes(f.severity)).length} issue(s) found`);
    findings.filter((f) => ['CRITICAL', 'HIGH'].includes(f.severity)).forEach((f) => summary.push(`  • [${f.ruleId}] ${f.message}`));
  }

  return makeResult(intent, solution, status, findings, summary, undefined, {
    tier: params.tier,
    score: params.score,
    appliedParams,
  });
}

// ── Intent pre-validation ─────────────────────────────────────────────────────

export async function validateIntent(
  intent: HIEFIntent
): Promise<HIEFPolicyResult> {
  const findings: PolicyFinding[] = [];
  const summary: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  if (intent.deadline <= now + 60) {
    findings.push({
      ruleId: 'R1',
      severity: 'CRITICAL',
      message: `Intent deadline ${intent.deadline} is too soon or expired`,
      evidence: { deadline: intent.deadline, now },
    });
  }

  if (intent.outputs.length === 0) {
    findings.push({
      ruleId: 'R10',
      severity: 'CRITICAL',
      message: 'Intent has no outputs defined',
    });
  }

  const status = findings.length === 0 ? 'PASS' : 'FAIL';
  summary.push(status === 'PASS' ? '✅ Intent pre-validation passed' : `❌ Intent pre-validation failed: ${findings.length} issue(s)`);

  return makeResult(intent, null, status, findings, summary);
}
