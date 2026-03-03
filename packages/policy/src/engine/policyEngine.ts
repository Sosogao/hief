import type { HIEFIntent, HIEFSolution, HIEFPolicyResult, PolicyFinding, ExecutionDiff } from '@hief/common';
import { computeIntentHash } from '@hief/common';
import { runStaticRules } from '../rules/staticRules';
import { simulateWithTenderly, buildExecutionDiff } from '../simulation/forkSimulator';

function makeResult(
  intent: HIEFIntent,
  solution: HIEFSolution | null,
  status: HIEFPolicyResult['status'],
  findings: PolicyFinding[],
  summary: string[],
  executionDiff?: ExecutionDiff
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
    timestamp: Math.floor(Date.now() / 1000),
  };
}

export async function validateSolution(
  intent: HIEFIntent,
  solution: HIEFSolution
): Promise<HIEFPolicyResult> {
  const findings: PolicyFinding[] = [];
  const summary: string[] = [];

  // ── Phase 1: Static Rules ─────────────────────────────────────────────
  const { results: ruleResults, hasCriticalFailure, hasHighFailure } = runStaticRules(intent, solution);

  for (const result of ruleResults) {
    if (!result.passed && result.finding) {
      // Map to PolicyFinding (without 'field' which is not in the type)
      const finding: PolicyFinding = {
        ruleId: result.finding.ruleId,
        severity: result.finding.severity,
        message: result.finding.message,
        evidence: result.finding.field ? { field: result.finding.field } : undefined,
      };
      findings.push(finding);
    }
  }

  // If critical rules fail, return immediately without simulation
  if (hasCriticalFailure) {
    const criticalFindings = findings.filter((f) => f.severity === 'CRITICAL');
    summary.push(`❌ FAIL: ${criticalFindings.length} critical rule(s) violated`);
    criticalFindings.forEach((f) => summary.push(`  • [${f.ruleId}] ${f.message}`));
    return makeResult(intent, solution, 'FAIL', findings, summary);
  }

  // ── Phase 2: Fork Simulation ──────────────────────────────────────────
  let executionDiff: ExecutionDiff | undefined;
  let simFailed = false;

  try {
    const simResult = await simulateWithTenderly(intent, solution);
    executionDiff = buildExecutionDiff(intent, solution, simResult);

    if (simResult && !simResult.success) {
      findings.push({
        ruleId: 'SIM-1',
        severity: 'CRITICAL',
        message: `Fork simulation reverted: ${simResult.revertReason || 'unknown reason'}`,
        evidence: { revertReason: simResult.revertReason },
      });
      simFailed = true;
      summary.push(`❌ FAIL: Simulation reverted - ${simResult.revertReason}`);
      return makeResult(intent, solution, 'FAIL', findings, summary, executionDiff);
    }
  } catch (err: any) {
    console.error('[POLICY] Simulation error:', err.message);
    findings.push({
      ruleId: 'SIM-0',
      severity: 'LOW',
      message: `Fork simulation unavailable: ${err.message}`,
    });
  }

  // ── Determine Final Status ────────────────────────────────────────────
  const hasAnyFailure = hasCriticalFailure || hasHighFailure || simFailed;
  const hasMediumWarnings = findings.some((f) => f.severity === 'MEDIUM');

  let status: HIEFPolicyResult['status'];
  if (hasAnyFailure) {
    status = 'FAIL';
  } else if (hasMediumWarnings) {
    status = 'WARN';
  } else {
    status = 'PASS';
  }

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

  return makeResult(intent, solution, status, findings, summary, executionDiff);
}

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
