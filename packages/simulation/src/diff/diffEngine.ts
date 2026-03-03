/**
 * HIEF Diff Engine
 *
 * Transforms raw Tenderly simulation responses into structured ExecutionDiff objects.
 * Detects:
 *  - Token balance changes (ERC-20 + native ETH)
 *  - ERC-20 approval changes (including unlimited approvals)
 *  - Contract storage diffs
 *  - DELEGATECALL presence in call trace
 */

import {
  TenderlySimulationResponse,
  TenderlyAssetChange,
  TenderlyCallTrace,
  ExecutionDiff,
  TokenBalanceDiff,
  ApprovalDiff,
  StorageDiff,
} from '../types';

const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
const UNLIMITED_THRESHOLD = MAX_UINT256 / BigInt(2);

const NATIVE_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export class DiffEngine {
  /**
   * Parse a single Tenderly simulation response into an ExecutionDiff.
   */
  parse(response: TenderlySimulationResponse): ExecutionDiff {
    const sim = response.simulation;
    const txInfo = response.transaction?.transaction_info ?? {};

    const assetChanges: TenderlyAssetChange[] = txInfo.asset_changes ?? [];
    const stateDiffs = txInfo.state_diff ?? [];

    const tokenBalanceDiffs = this._parseTokenBalanceDiffs(assetChanges);
    const approvalDiffs = this._parseApprovalDiffs(assetChanges);
    const storageDiffs = this._parseStorageDiffs(stateDiffs);

    return {
      simulationId: sim.id,
      simulationSuccess: sim.status,
      errorMessage: sim.error_message,
      gasUsed: sim.gas_used,
      tokenBalanceDiffs,
      approvalDiffs,
      storageDiffs,
      rawAssetChanges: assetChanges,
    };
  }

  /**
   * Check whether a call trace contains any DELEGATECALL.
   */
  hasDelegatecall(trace: TenderlyCallTrace | undefined): boolean {
    if (!trace) return false;
    if (trace.call_type?.toUpperCase() === 'DELEGATECALL') return true;
    return (trace.calls ?? []).some((child) => this.hasDelegatecall(child));
  }

  // ── Private parsers ────────────────────────────────────────────────────

  private _parseTokenBalanceDiffs(assetChanges: TenderlyAssetChange[]): TokenBalanceDiff[] {
    const diffs: TokenBalanceDiff[] = [];

    for (const change of assetChanges) {
      if (change.type !== 'Transfer' && change.type !== 'Mint' && change.type !== 'Burn') {
        continue;
      }

      const tokenInfo = change.token_info;
      const decimals = tokenInfo.decimals ?? 18;
      const symbol = tokenInfo.symbol ?? 'UNKNOWN';
      const tokenAddress = tokenInfo.contract_address ?? NATIVE_ADDRESS;
      const rawAmount = BigInt(change.raw_amount ?? '0');
      const dollarValue = change.dollar_value ? parseFloat(change.dollar_value) : undefined;

      // Outflow from `from` address
      if (change.from && change.from !== '0x0000000000000000000000000000000000000000') {
        diffs.push({
          address: change.from.toLowerCase(),
          tokenAddress: tokenAddress.toLowerCase(),
          symbol,
          decimals,
          before: rawAmount,
          after: BigInt(0),
          delta: -rawAmount,
          deltaUsd: dollarValue !== undefined ? -dollarValue : undefined,
        });
      }

      // Inflow to `to` address
      if (change.to && change.to !== '0x0000000000000000000000000000000000000000') {
        diffs.push({
          address: change.to.toLowerCase(),
          tokenAddress: tokenAddress.toLowerCase(),
          symbol,
          decimals,
          before: BigInt(0),
          after: rawAmount,
          delta: rawAmount,
          deltaUsd: dollarValue,
        });
      }
    }

    return diffs;
  }

  private _parseApprovalDiffs(assetChanges: TenderlyAssetChange[]): ApprovalDiff[] {
    const diffs: ApprovalDiff[] = [];

    for (const change of assetChanges) {
      if (change.type !== 'Approve') continue;

      const tokenInfo = change.token_info;
      const rawAmount = BigInt(change.raw_amount ?? '0');
      const isUnlimited = rawAmount >= UNLIMITED_THRESHOLD;

      diffs.push({
        owner: (change.from ?? '').toLowerCase(),
        spender: (change.to ?? '').toLowerCase(),
        tokenAddress: (tokenInfo.contract_address ?? '').toLowerCase(),
        symbol: tokenInfo.symbol ?? 'UNKNOWN',
        allowanceBefore: BigInt(0),  // Tenderly doesn't provide pre-approval state directly
        allowanceAfter: rawAmount,
        isUnlimited,
      });
    }

    return diffs;
  }

  private _parseStorageDiffs(
    stateDiffs: Array<{ address: string; original: string; dirty: string }>
  ): StorageDiff[] {
    return stateDiffs.map((d) => ({
      contractAddress: d.address.toLowerCase(),
      slot: '',  // Tenderly state_diff provides human-readable names, not raw slots
      before: d.original,
      after: d.dirty,
    }));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Calculate net USD outflow for a given user address from an ExecutionDiff.
 * Positive = net outflow (user spent money), negative = net inflow.
 */
export function calcNetOutflowUsd(diff: ExecutionDiff, userAddress: string): number {
  const addr = userAddress.toLowerCase();
  let netOutflow = 0;

  for (const bd of diff.tokenBalanceDiffs) {
    if (bd.address !== addr) continue;
    if (bd.deltaUsd !== undefined) {
      // delta is negative for outflows
      netOutflow -= bd.deltaUsd; // negate: negative delta → positive outflow
    }
  }

  return netOutflow;
}

/**
 * Find all unlimited approvals in a diff for a given user.
 */
export function findUnlimitedApprovals(diff: ExecutionDiff, userAddress: string): ApprovalDiff[] {
  const addr = userAddress.toLowerCase();
  return diff.approvalDiffs.filter((a) => a.owner === addr && a.isUnlimited);
}
