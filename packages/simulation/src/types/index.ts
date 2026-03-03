/**
 * HIEF Simulation Layer — Core Types
 * Covers Tenderly API request/response shapes and internal diff structures.
 */

// ─── Tenderly API Types ────────────────────────────────────────────────────

export interface TenderlyConfig {
  accountSlug: string;
  projectSlug: string;
  apiKey: string;
  /** Default network ID, e.g. "8453" for Base mainnet, "84532" for Base Sepolia */
  networkId: string;
}

/** Single transaction payload sent to Tenderly Simulation API */
export interface TenderlySimulationRequest {
  network_id: string;
  block_number?: number | 'latest';
  from: string;
  to: string;
  input: string;
  gas?: number;
  gas_price?: string;
  value?: string;
  /** "full" | "quick" | "abi" — default "full" */
  simulation_type?: 'full' | 'quick' | 'abi';
  save?: boolean;
  save_if_fails?: boolean;
  /** State overrides: address → { balance?, nonce?, code?, state? } */
  state_objects?: Record<string, TenderlyStateObject>;
}

export interface TenderlyStateObject {
  balance?: string;
  nonce?: number;
  code?: string;
  state?: Record<string, string>;
}

/** Tenderly simulation response (simplified to fields we consume) */
export interface TenderlySimulationResponse {
  simulation: {
    id: string;
    status: boolean;       // true = success, false = reverted
    error_message?: string;
    gas_used: number;
    block_number: number;
  };
  transaction: {
    transaction_info: {
      asset_changes?: TenderlyAssetChange[];
      balance_changes?: TenderlyBalanceChange[];
      state_diff?: TenderlyStateDiff[];
      logs?: TenderlyLog[];
      call_trace?: TenderlyCallTrace;
    };
  };
}

export interface TenderlyAssetChange {
  token_info: {
    standard: 'ERC20' | 'ERC721' | 'NativeCurrency';
    type: string;
    contract_address?: string;
    symbol?: string;
    decimals?: number;
    dollar_value?: string;
  };
  type: 'Transfer' | 'Mint' | 'Burn' | 'Approve';
  from?: string;
  to?: string;
  amount?: string;
  raw_amount?: string;
  dollar_value?: string;
}

export interface TenderlyBalanceChange {
  address: string;
  original: string;
  dirty: string;
  is_miner: boolean;
}

export interface TenderlyStateDiff {
  address: string;
  soltype?: { name: string; type: string };
  original: string;
  dirty: string;
}

export interface TenderlyLog {
  name?: string;
  anonymous: boolean;
  inputs?: Array<{ value: string; type: string; name: string }>;
  raw: { address: string; topics: string[]; data: string };
}

export interface TenderlyCallTrace {
  call_type: string;
  from: string;
  to: string;
  value?: string;
  gas: number;
  gas_used: number;
  error?: string;
  calls?: TenderlyCallTrace[];
}

/** Bundle simulation request */
export interface TenderlyBundleRequest {
  simulations: TenderlySimulationRequest[];
}

export interface TenderlyBundleResponse {
  simulation_results: TenderlySimulationResponse[];
}

// ─── Diff Engine Types ─────────────────────────────────────────────────────

/** Normalised token balance change produced by DiffEngine */
export interface TokenBalanceDiff {
  address: string;          // wallet address
  tokenAddress: string;     // ERC20 contract or "native"
  symbol: string;
  decimals: number;
  before: bigint;
  after: bigint;
  delta: bigint;            // after - before (negative = outflow)
  deltaUsd?: number;
}

/** ERC-20 approval change detected in simulation */
export interface ApprovalDiff {
  owner: string;
  spender: string;
  tokenAddress: string;
  symbol: string;
  allowanceBefore: bigint;
  allowanceAfter: bigint;
  isUnlimited: boolean;     // allowanceAfter >= MAX_UINT256 / 2
}

/** Unexpected contract state change */
export interface StorageDiff {
  contractAddress: string;
  slot: string;
  before: string;
  after: string;
}

/** Aggregated execution diff — output of DiffEngine */
export interface ExecutionDiff {
  simulationId: string;
  simulationSuccess: boolean;
  errorMessage?: string;
  gasUsed: number;
  tokenBalanceDiffs: TokenBalanceDiff[];
  approvalDiffs: ApprovalDiff[];
  storageDiffs: StorageDiff[];
  /** Raw asset changes from Tenderly for downstream consumers */
  rawAssetChanges: TenderlyAssetChange[];
}

// ─── Policy L4 Integration Types ──────────────────────────────────────────

export type SimulationStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface SimulationPolicyResult {
  status: SimulationStatus;
  simulationId?: string;
  findings: SimulationFinding[];
  executionDiff?: ExecutionDiff;
  /** Elapsed time in ms */
  durationMs: number;
}

export interface SimulationFinding {
  ruleId: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
  detail?: Record<string, unknown>;
}

// ─── Simulation Rules Config ───────────────────────────────────────────────

export interface SimulationRulesConfig {
  /** Maximum allowed outflow in USD (default: 110% of quoted amount) */
  maxOutflowUsdMultiplier: number;
  /** Maximum slippage in bps (default: 1000 = 10%) */
  maxSlippageBps: number;
  /** Whether to block unlimited ERC-20 approvals */
  blockUnlimitedApprovals: boolean;
  /** Whether to block DELEGATECALL in execution trace */
  blockDelegatecall: boolean;
  /** Minimum simulation gas (sanity check) */
  minGasUsed: number;
}

export const DEFAULT_SIMULATION_RULES: SimulationRulesConfig = {
  maxOutflowUsdMultiplier: 1.1,
  maxSlippageBps: 1000,
  blockUnlimitedApprovals: true,
  blockDelegatecall: true,
  minGasUsed: 21000,
};
