export type Address = string;
export type Bytes32 = string;
export type HexString = string;
export type UintString = string;
export interface InputAsset {
    token: Address;
    amount: UintString;
}
export interface OutputConstraint {
    token: Address;
    minAmount: UintString;
    recipient?: Address;
}
export interface Constraints {
    slippageBps?: number;
    maxSpend?: UintString;
    nonceSalt?: Bytes32;
}
export interface PriorityFee {
    token: 'HIEF';
    amount: UintString;
}
export interface PolicyRef {
    policyVersion: string;
    policyHash?: Bytes32;
}
export interface ReputationSnapshotRef {
    type: 'block' | 'hash' | 'timestamp';
    value: string;
}
export interface IntentSignature {
    type: 'EIP712_EOA' | 'SAFE' | 'ERC1271';
    signer: Address;
    sig: HexString;
}
export interface IntentMeta {
    title?: string;
    userIntentText?: string;
    tags?: string[];
    uiHints?: Record<string, unknown>;
}
export interface HIEFIntent {
    intentVersion: '0.1';
    intentId: Bytes32;
    smartAccount: Address;
    chainId: number;
    deadline: number;
    input: InputAsset;
    outputs: OutputConstraint[];
    constraints: Constraints;
    priorityFee: PriorityFee;
    policyRef: PolicyRef;
    reputationSnapshotRef?: ReputationSnapshotRef;
    meta?: IntentMeta;
    extensions?: Record<string, unknown>;
    signature: IntentSignature;
}
export interface Call {
    to: Address;
    value: UintString;
    data: HexString;
    operation: 'CALL' | 'DELEGATECALL';
}
export interface ExecutionPlan {
    calls: Call[];
}
export interface Quote {
    expectedOut: UintString;
    fee: UintString;
    validUntil: number;
}
export interface StakeSnapshot {
    amount: UintString;
    blockNumber?: number;
}
export interface SimulationRef {
    type: string;
    value: string;
}
export interface SolutionSignature {
    type: 'EIP712_EOA';
    signer: Address;
    sig: HexString;
}
export interface HIEFSolution {
    solutionVersion: '0.1';
    solutionId: Bytes32;
    intentId: Bytes32;
    intentHash: Bytes32;
    solverId: Address;
    executionPlan: ExecutionPlan;
    quote: Quote;
    stakeSnapshot: StakeSnapshot;
    simulationRef?: SimulationRef;
    meta?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
    signature: SolutionSignature;
}
export type PolicyStatus = 'PASS' | 'WARN' | 'FAIL';
export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export interface PolicyFinding {
    ruleId: string;
    severity: Severity;
    message: string;
    evidence?: Record<string, unknown>;
    relatedCallIndex?: number;
}
export interface EvidenceRef {
    type: string;
    value: string;
}
export interface TokenChange {
    account: Address;
    token: Address;
    delta: string;
}
export interface AllowanceChange {
    owner: Address;
    spender: Address;
    token: Address;
    newAllowance: UintString;
}
export interface ExecutionDiff {
    tokenChanges: TokenChange[];
    allowanceChanges: AllowanceChange[];
    safeConfigChanged: boolean;
}
export interface PolicyResultSignature {
    type: 'POLICY_SERVER';
    signer: Address;
    sig: HexString;
}
export interface HIEFPolicyResult {
    policyResultVersion: '0.1';
    policyRef: PolicyRef;
    intentHash: Bytes32;
    solutionId?: Bytes32;
    solutionHash?: Bytes32;
    status: PolicyStatus;
    findings: PolicyFinding[];
    riskTags: string[];
    summary: string[];
    evidenceRefs?: EvidenceRef[];
    executionDiff?: ExecutionDiff;
    timestamp: number;
    signature?: PolicyResultSignature;
}
export interface AsOf {
    chainId: number;
    blockNumber: number;
    timestamp: number;
}
export interface ReputationScores {
    successRate: number;
    riskScore: number;
    volumeScore: number;
    diversityScore: number;
    alphaScore?: number;
}
export interface ReputationMetrics {
    totalIntents: number;
    successfulIntents: number;
    failedIntents: number;
    totalVolumeUSD: UintString;
    uniqueSkillsUsed: number;
    lastActivityTimestamp: number;
}
export interface ReputationSignature {
    type: 'REPUTATION_SERVICE';
    signer: Address;
    sig: HexString;
}
export interface HIEFReputationSnapshot {
    repVersion: '0.1';
    account: Address;
    asOf: AsOf;
    scores: ReputationScores;
    metrics: ReputationMetrics;
    behaviorTags: string[];
    signature?: ReputationSignature;
}
export type IntentStatus = 'CREATED' | 'BROADCAST' | 'QUOTING' | 'SELECTED' | 'VALIDATING' | 'PROPOSING' | 'EXECUTING' | 'EXECUTED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
export type SolutionStatus = 'SUBMITTED' | 'RANKED' | 'SELECTED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED';
export type ProposalStatus = 'CREATED' | 'PROPOSED_TO_SAFE' | 'SIGNED' | 'EXECUTING' | 'EXECUTED' | 'FAILED' | 'REJECTED';
export interface SubmitIntentResponse {
    intentId: Bytes32;
    intentHash: Bytes32;
    status: 'BROADCAST';
    quoteWindowMs: number;
}
export interface SolutionSummary {
    solutionId: Bytes32;
    solverId: Address;
    expectedOut: UintString;
    fee: UintString;
    validUntil: number;
    status: SolutionStatus;
}
export interface ListSolutionsResponse {
    intentId: Bytes32;
    solutions: SolutionSummary[];
}
export interface SelectSolutionRequest {
    solutionId: Bytes32;
    selectionReason?: 'BEST_QUOTE' | 'BEST_SCORE' | 'USER_CHOICE' | 'FALLBACK';
}
export interface SelectSolutionResponse {
    intentId: Bytes32;
    selectedSolutionId: Bytes32;
    status: 'SELECTED';
}
export interface CreateProposalRequest {
    solutionId: Bytes32;
    adapter: 'SAFE_V1';
    safeAddress: Address;
    chainId: number;
}
export interface CreateProposalResponse {
    proposalId: string;
    status: 'PROPOSED_TO_SAFE';
    safeTxHash?: Bytes32;
    humanSummary: string[];
}
export interface APIError {
    errorCode: string;
    message: string;
}
//# sourceMappingURL=index.d.ts.map