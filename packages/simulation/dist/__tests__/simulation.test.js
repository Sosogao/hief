"use strict";
/**
 * @hief/simulation — Unit Tests
 *
 * Tests cover:
 *  - DiffEngine: token balance parsing, approval parsing, storage diffs
 *  - SimulationEngine: all 7 SIM rules (mock Tenderly client)
 *  - Graceful degradation (no Tenderly config)
 *  - calcNetOutflowUsd and findUnlimitedApprovals helpers
 */
Object.defineProperty(exports, "__esModule", { value: true });
const diffEngine_1 = require("../diff/diffEngine");
const simulationEngine_1 = require("../engine/simulationEngine");
const tenderlyClient_1 = require("../tenderly/tenderlyClient");
// ── Fixtures ──────────────────────────────────────────────────────────────────
const USER_ADDR = '0xUserAddress000000000000000000000000000001';
const USDC_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ETH_ADDR = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SPENDER = '0xSpender00000000000000000000000000000001';
const SAFE_ADDR = '0xSafeAddress000000000000000000000000000001';
function makeMockSimResponse(overrides) {
    return {
        simulation: {
            id: 'sim-test-001',
            status: overrides.status ?? true,
            error_message: overrides.errorMessage,
            gas_used: overrides.gasUsed ?? 150_000,
            block_number: 12345678,
        },
        transaction: {
            transaction_info: {
                asset_changes: overrides.assetChanges ?? [],
                state_diff: overrides.stateDiff ?? [],
            },
        },
    };
}
function makeSwapSolution(overrides = {}) {
    return {
        intentHash: '0xintent001',
        solutionHash: '0xsolution001',
        solver: '0xSolver',
        executionPlan: {
            safeAddress: SAFE_ADDR,
            calls: [
                {
                    to: '0xCoWSwap',
                    data: '0xswapdata',
                    value: '0',
                    operation: overrides.operation ?? 0,
                },
            ],
            nonce: 1,
            chainId: 84532,
        },
        quote: {
            inputToken: USDC_ADDR,
            inputAmount: '1000000000', // 1000 USDC
            outputToken: overrides.outputToken ?? ETH_ADDR,
            outputAmount: '400000000000000000', // 0.4 ETH
            slippageBps: overrides.slippageBps ?? 50,
            quoteUsd: overrides.quoteUsd ?? 1000,
        },
        signature: '0xsig',
    };
}
// ── DiffEngine Tests ──────────────────────────────────────────────────────────
describe('DiffEngine', () => {
    const engine = new diffEngine_1.DiffEngine();
    test('parses ERC-20 Transfer outflow and inflow correctly', () => {
        const resp = makeMockSimResponse({
            assetChanges: [
                {
                    token_info: { standard: 'ERC20', contract_address: USDC_ADDR, symbol: 'USDC', decimals: 6 },
                    type: 'Transfer',
                    from: USER_ADDR.toLowerCase(),
                    to: '0xCoWSwap',
                    raw_amount: '1000000000',
                    dollar_value: '1000.00',
                },
            ],
        });
        const diff = engine.parse(resp);
        expect(diff.simulationSuccess).toBe(true);
        expect(diff.tokenBalanceDiffs).toHaveLength(2);
        const outflow = diff.tokenBalanceDiffs.find((d) => d.address === USER_ADDR.toLowerCase());
        expect(outflow).toBeDefined();
        expect(outflow.delta).toBe(BigInt('-1000000000'));
        expect(outflow.deltaUsd).toBe(-1000);
    });
    test('parses ERC-20 Approve with unlimited amount', () => {
        const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
        const resp = makeMockSimResponse({
            assetChanges: [
                {
                    token_info: { standard: 'ERC20', contract_address: USDC_ADDR, symbol: 'USDC', decimals: 6 },
                    type: 'Approve',
                    from: USER_ADDR.toLowerCase(),
                    to: SPENDER.toLowerCase(),
                    raw_amount: MAX,
                },
            ],
        });
        const diff = engine.parse(resp);
        expect(diff.approvalDiffs).toHaveLength(1);
        expect(diff.approvalDiffs[0].isUnlimited).toBe(true);
        expect(diff.approvalDiffs[0].spender).toBe(SPENDER.toLowerCase());
    });
    test('parses limited ERC-20 Approve correctly', () => {
        const resp = makeMockSimResponse({
            assetChanges: [
                {
                    token_info: { standard: 'ERC20', contract_address: USDC_ADDR, symbol: 'USDC', decimals: 6 },
                    type: 'Approve',
                    from: USER_ADDR.toLowerCase(),
                    to: SPENDER.toLowerCase(),
                    raw_amount: '1000000000',
                },
            ],
        });
        const diff = engine.parse(resp);
        expect(diff.approvalDiffs[0].isUnlimited).toBe(false);
    });
    test('returns failed simulation correctly', () => {
        const resp = makeMockSimResponse({
            status: false,
            errorMessage: 'execution reverted: insufficient output amount',
        });
        const diff = engine.parse(resp);
        expect(diff.simulationSuccess).toBe(false);
        expect(diff.errorMessage).toContain('insufficient output amount');
    });
    test('parses storage diffs', () => {
        const resp = makeMockSimResponse({
            stateDiff: [
                { address: '0xContract', original: '0x0', dirty: '0x1' },
            ],
        });
        const diff = engine.parse(resp);
        expect(diff.storageDiffs).toHaveLength(1);
        expect(diff.storageDiffs[0].before).toBe('0x0');
        expect(diff.storageDiffs[0].after).toBe('0x1');
    });
});
// ── Helper Tests ──────────────────────────────────────────────────────────────
describe('calcNetOutflowUsd', () => {
    test('calculates net outflow for user address', () => {
        const diff = {
            simulationId: 'test',
            simulationSuccess: true,
            gasUsed: 100000,
            tokenBalanceDiffs: [
                {
                    address: USER_ADDR.toLowerCase(),
                    tokenAddress: USDC_ADDR,
                    symbol: 'USDC',
                    decimals: 6,
                    before: BigInt(1000),
                    after: BigInt(0),
                    delta: BigInt(-1000),
                    deltaUsd: -1000,
                },
                {
                    address: USER_ADDR.toLowerCase(),
                    tokenAddress: ETH_ADDR,
                    symbol: 'ETH',
                    decimals: 18,
                    before: BigInt(0),
                    after: BigInt(400000000000000000n),
                    delta: BigInt(400000000000000000n),
                    deltaUsd: 950,
                },
            ],
            approvalDiffs: [],
            storageDiffs: [],
            rawAssetChanges: [],
        };
        // Outflow = 1000 USDC out, 950 USD in → net outflow = 1000 - 950 = 50
        const netOutflow = (0, diffEngine_1.calcNetOutflowUsd)(diff, USER_ADDR);
        expect(netOutflow).toBeCloseTo(50, 0);
    });
});
describe('findUnlimitedApprovals', () => {
    test('returns only unlimited approvals for user', () => {
        const MAX = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
        const diff = {
            simulationId: 'test',
            simulationSuccess: true,
            gasUsed: 100000,
            tokenBalanceDiffs: [],
            approvalDiffs: [
                {
                    owner: USER_ADDR.toLowerCase(),
                    spender: SPENDER.toLowerCase(),
                    tokenAddress: USDC_ADDR,
                    symbol: 'USDC',
                    allowanceBefore: BigInt(0),
                    allowanceAfter: MAX,
                    isUnlimited: true,
                },
                {
                    owner: USER_ADDR.toLowerCase(),
                    spender: SPENDER.toLowerCase(),
                    tokenAddress: USDC_ADDR,
                    symbol: 'USDC',
                    allowanceBefore: BigInt(0),
                    allowanceAfter: BigInt(1000),
                    isUnlimited: false,
                },
            ],
            storageDiffs: [],
            rawAssetChanges: [],
        };
        const unlimited = (0, diffEngine_1.findUnlimitedApprovals)(diff, USER_ADDR);
        expect(unlimited).toHaveLength(1);
        expect(unlimited[0].isUnlimited).toBe(true);
    });
});
// ── SimulationEngine Tests ────────────────────────────────────────────────────
describe('SimulationEngine', () => {
    // Build a mock TenderlyClient
    function mockTenderly(response) {
        const client = Object.create(tenderlyClient_1.TenderlyClient.prototype);
        client.simulate = jest.fn().mockResolvedValue(response);
        client.simulateBundle = jest.fn().mockResolvedValue({
            simulation_results: [response],
        });
        return client;
    }
    test('SIM-00: returns SKIP when no Tenderly client', async () => {
        const engine = new simulationEngine_1.SimulationEngine(null);
        const result = await engine.verify(makeSwapSolution());
        expect(result.status).toBe('SKIP');
        expect(result.findings[0].ruleId).toBe('SIM-00');
    });
    test('SIM-01: FAIL when simulation reverts', async () => {
        const resp = makeMockSimResponse({ status: false, errorMessage: 'reverted' });
        const engine = new simulationEngine_1.SimulationEngine(mockTenderly(resp));
        const result = await engine.verify(makeSwapSolution());
        expect(result.status).toBe('FAIL');
        expect(result.findings.some((f) => f.ruleId === 'SIM-01')).toBe(true);
    });
    test('SIM-02: FAIL when outflow exceeds 110% of quote', async () => {
        // Simulate user losing $1200 on a $1000 quote → exceeds 110%
        const resp = makeMockSimResponse({
            assetChanges: [
                {
                    token_info: { standard: 'ERC20', contract_address: USDC_ADDR, symbol: 'USDC', decimals: 6 },
                    type: 'Transfer',
                    from: SAFE_ADDR.toLowerCase(),
                    to: '0xCoWSwap',
                    raw_amount: '1200000000',
                    dollar_value: '1200.00',
                },
            ],
        });
        const engine = new simulationEngine_1.SimulationEngine(mockTenderly(resp));
        const result = await engine.verify(makeSwapSolution({ quoteUsd: 1000 }));
        expect(result.findings.some((f) => f.ruleId === 'SIM-02')).toBe(true);
        expect(result.status).toBe('FAIL');
    });
    test('SIM-02: PASS when outflow is within 110% of quote', async () => {
        // Simulate user losing $1050 on a $1000 quote → within 110%
        const resp = makeMockSimResponse({
            assetChanges: [
                {
                    token_info: { standard: 'ERC20', contract_address: USDC_ADDR, symbol: 'USDC', decimals: 6 },
                    type: 'Transfer',
                    from: SAFE_ADDR.toLowerCase(),
                    to: '0xCoWSwap',
                    raw_amount: '1050000000',
                    dollar_value: '1050.00',
                },
                {
                    token_info: { standard: 'NativeCurrency', symbol: 'ETH', decimals: 18 },
                    type: 'Transfer',
                    from: '0xCoWSwap',
                    to: SAFE_ADDR.toLowerCase(),
                    raw_amount: '400000000000000000',
                    dollar_value: '1000.00',
                },
            ],
        });
        const engine = new simulationEngine_1.SimulationEngine(mockTenderly(resp));
        const result = await engine.verify(makeSwapSolution({ quoteUsd: 1000 }));
        expect(result.findings.some((f) => f.ruleId === 'SIM-02')).toBe(false);
    });
    test('SIM-03: FAIL when slippage exceeds 1000bps', async () => {
        const resp = makeMockSimResponse({});
        const engine = new simulationEngine_1.SimulationEngine(mockTenderly(resp));
        const result = await engine.verify(makeSwapSolution({ slippageBps: 1500 }));
        expect(result.findings.some((f) => f.ruleId === 'SIM-03')).toBe(true);
        expect(result.status).toBe('FAIL');
    });
    test('SIM-04: FAIL when unlimited ERC-20 approval detected', async () => {
        const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
        const resp = makeMockSimResponse({
            assetChanges: [
                {
                    token_info: { standard: 'ERC20', contract_address: USDC_ADDR, symbol: 'USDC', decimals: 6 },
                    type: 'Approve',
                    from: SAFE_ADDR.toLowerCase(),
                    to: SPENDER.toLowerCase(),
                    raw_amount: MAX,
                },
            ],
        });
        const engine = new simulationEngine_1.SimulationEngine(mockTenderly(resp));
        const result = await engine.verify(makeSwapSolution());
        expect(result.findings.some((f) => f.ruleId === 'SIM-04')).toBe(true);
        expect(result.status).toBe('FAIL');
    });
    test('SIM-05: FAIL when DELEGATECALL operation detected', async () => {
        const resp = makeMockSimResponse({});
        const engine = new simulationEngine_1.SimulationEngine(mockTenderly(resp));
        const solution = makeSwapSolution({ operation: 1 }); // DELEGATECALL
        const result = await engine.verify(solution);
        expect(result.findings.some((f) => f.ruleId === 'SIM-05')).toBe(true);
        expect(result.status).toBe('FAIL');
    });
    test('SIM-06: MEDIUM finding when gas is suspiciously low', async () => {
        const resp = makeMockSimResponse({ gasUsed: 100 }); // below 21000
        const engine = new simulationEngine_1.SimulationEngine(mockTenderly(resp));
        const result = await engine.verify(makeSwapSolution());
        expect(result.findings.some((f) => f.ruleId === 'SIM-06')).toBe(true);
        // MEDIUM only → should still PASS
        expect(result.status).toBe('PASS');
    });
    test('PASS: clean swap with correct output token', async () => {
        const resp = makeMockSimResponse({
            gasUsed: 200_000,
            assetChanges: [
                {
                    token_info: { standard: 'ERC20', contract_address: USDC_ADDR, symbol: 'USDC', decimals: 6 },
                    type: 'Transfer',
                    from: SAFE_ADDR.toLowerCase(),
                    to: '0xCoWSwap',
                    raw_amount: '1000000000',
                    dollar_value: '1000.00',
                },
                {
                    token_info: { standard: 'NativeCurrency', symbol: 'ETH', decimals: 18, contract_address: ETH_ADDR },
                    type: 'Transfer',
                    from: '0xCoWSwap',
                    to: SAFE_ADDR.toLowerCase(),
                    raw_amount: '400000000000000000',
                    dollar_value: '950.00',
                },
            ],
        });
        const engine = new simulationEngine_1.SimulationEngine(mockTenderly(resp));
        const result = await engine.verify(makeSwapSolution({ quoteUsd: 1000 }));
        // Net outflow = $1000 - $950 = $50, within 110% of $1000
        const criticalOrHigh = result.findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
        expect(criticalOrHigh).toHaveLength(0);
        expect(result.status).toBe('PASS');
    });
    test('returns SKIP when Tenderly returns null (unreachable)', async () => {
        const client = Object.create(tenderlyClient_1.TenderlyClient.prototype);
        client.simulate = jest.fn().mockResolvedValue(null);
        const engine = new simulationEngine_1.SimulationEngine(client);
        const result = await engine.verify(makeSwapSolution());
        expect(result.status).toBe('SKIP');
    });
});
//# sourceMappingURL=simulation.test.js.map