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
import { TenderlySimulationResponse, TenderlyCallTrace, ExecutionDiff, ApprovalDiff } from '../types';
export declare class DiffEngine {
    /**
     * Parse a single Tenderly simulation response into an ExecutionDiff.
     */
    parse(response: TenderlySimulationResponse): ExecutionDiff;
    /**
     * Check whether a call trace contains any DELEGATECALL.
     */
    hasDelegatecall(trace: TenderlyCallTrace | undefined): boolean;
    private _parseTokenBalanceDiffs;
    private _parseApprovalDiffs;
    private _parseStorageDiffs;
}
/**
 * Calculate net USD outflow for a given user address from an ExecutionDiff.
 * Positive = net outflow (user spent money), negative = net inflow.
 */
export declare function calcNetOutflowUsd(diff: ExecutionDiff, userAddress: string): number;
/**
 * Find all unlimited approvals in a diff for a given user.
 */
export declare function findUnlimitedApprovals(diff: ExecutionDiff, userAddress: string): ApprovalDiff[];
//# sourceMappingURL=diffEngine.d.ts.map