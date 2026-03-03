import axios from 'axios';
import type { HIEFIntent, HIEFSolution, ExecutionDiff, TokenChange, AllowanceChange } from '@hief/common';

const TENDERLY_API_KEY = process.env.TENDERLY_API_KEY;
const TENDERLY_ACCOUNT = process.env.TENDERLY_ACCOUNT;
const TENDERLY_PROJECT = process.env.TENDERLY_PROJECT;

export interface SimulationResult {
  success: boolean;
  gasUsed: number;
  tokenChanges: TokenChange[];
  allowanceChanges: AllowanceChange[];
  revertReason?: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

/**
 * Simulate the execution plan using Tenderly's simulation API.
 * Returns balance changes and execution result.
 */
export async function simulateWithTenderly(
  intent: HIEFIntent,
  solution: HIEFSolution
): Promise<SimulationResult | null> {
  if (!TENDERLY_API_KEY || !TENDERLY_ACCOUNT || !TENDERLY_PROJECT) {
    console.log('[POLICY] Tenderly not configured, skipping fork simulation');
    return null;
  }

  const CHAIN_TO_NETWORK: Record<number, string> = {
    1: 'mainnet',
    8453: 'base-mainnet',
    84532: 'base-sepolia',
    31337: 'mainnet',
  };

  const networkId = CHAIN_TO_NETWORK[intent.chainId];
  if (!networkId) {
    console.log(`[POLICY] No Tenderly network for chainId ${intent.chainId}`);
    return null;
  }

  const calls = solution.executionPlan.calls;

  try {
    const simulations = calls.map((call) => ({
      network_id: intent.chainId.toString(),
      from: intent.smartAccount,
      to: call.to,
      input: call.data,
      value: call.value || '0x0',
      gas: 3000000,
      gas_price: '0',
      save: false,
      save_if_fails: false,
    }));

    const response = await axios.post(
      `https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT}/project/${TENDERLY_PROJECT}/simulate-bundle`,
      { simulations },
      {
        headers: {
          'X-Access-Key': TENDERLY_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const results = response.data.simulation_results;
    if (!results || results.length === 0) return null;

    let totalGas = 0;
    let allSuccess = true;
    let revertReason: string | undefined;
    const allLogs: SimulationResult['logs'] = [];
    const tokenChanges: TokenChange[] = [];
    const allowanceChanges: AllowanceChange[] = [];

    for (const result of results) {
      const sim = result.simulation;
      if (!sim.status) {
        allSuccess = false;
        revertReason = sim.error_message || 'Simulation reverted';
        break;
      }
      totalGas += sim.gas_used || 0;
      if (result.transaction?.transaction_info?.logs) {
        allLogs.push(...result.transaction.transaction_info.logs);
      }
      // Extract balance changes from asset changes
      if (result.transaction?.transaction_info?.asset_changes) {
        for (const change of result.transaction.transaction_info.asset_changes) {
          tokenChanges.push({
            account: change.to || intent.smartAccount,
            token: change.token_info?.contract_address || 'ETH',
            delta: change.amount || '0',
          });
        }
      }
    }

    return {
      success: allSuccess,
      gasUsed: totalGas,
      tokenChanges,
      allowanceChanges,
      revertReason,
      logs: allLogs,
    };
  } catch (err: any) {
    console.error('[POLICY] Tenderly simulation failed:', err.message);
    return null;
  }
}

/**
 * Build the ExecutionDiff from a simulation result.
 */
export function buildExecutionDiff(
  intent: HIEFIntent,
  solution: HIEFSolution,
  simResult: SimulationResult | null
): ExecutionDiff {
  const diff: ExecutionDiff = {
    tokenChanges: simResult?.tokenChanges ?? [],
    allowanceChanges: simResult?.allowanceChanges ?? [],
    safeConfigChanged: false,
  };

  return diff;
}
