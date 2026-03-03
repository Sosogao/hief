import axios from 'axios';
import type { HIEFIntent, HIEFSolution, HIEFPolicyResult } from '@hief/common';

const POLICY_ENGINE_URL =
  process.env.POLICY_ENGINE_URL || 'http://localhost:3002';

/**
 * Call the Policy Engine to validate a Solution against an Intent.
 * This is the critical security checkpoint before creating a Safe proposal.
 */
export async function callPolicyEngine(
  intent: HIEFIntent,
  solution: HIEFSolution
): Promise<HIEFPolicyResult> {
  const response = await axios.post<HIEFPolicyResult>(
    `${POLICY_ENGINE_URL}/v1/policy/validateSolution`,
    { intent, solution },
    { timeout: 30000 } // 30s timeout for fork simulation
  );
  return response.data;
}

/**
 * Call the Policy Engine to pre-validate an Intent (lightweight check).
 */
export async function callPolicyEngineForIntent(
  intent: HIEFIntent
): Promise<HIEFPolicyResult> {
  const response = await axios.post<HIEFPolicyResult>(
    `${POLICY_ENGINE_URL}/v1/policy/validateIntent`,
    { intent },
    { timeout: 10000 }
  );
  return response.data;
}
