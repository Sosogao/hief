"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ethers_1 = require("ethers");
const policyEngine_1 = require("../engine/policyEngine");
const wallet = new ethers_1.ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
function makeIntent(overrides = {}) {
    const intentId = ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32));
    return {
        intentVersion: '0.1',
        intentId,
        smartAccount: wallet.address,
        chainId: 8453,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        input: {
            token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: '1000000000',
        },
        outputs: [
            {
                token: '0x4200000000000000000000000000000000000006',
                minAmount: '250000000000000000',
            },
        ],
        constraints: { slippageBps: 50 },
        priorityFee: { token: 'HIEF', amount: '0' },
        policyRef: { policyVersion: 'v0.1' },
        signature: { type: 'EIP712_EOA', signer: wallet.address, sig: '0x1234' },
        ...overrides,
    };
}
function makeSolution(intent, overrides = {}) {
    return {
        solutionVersion: '0.1',
        solutionId: ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32)),
        intentId: intent.intentId,
        intentHash: ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32)), // mock hash
        solverId: wallet.address,
        executionPlan: {
            calls: [
                {
                    to: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', // CoW Settlement
                    value: '0',
                    data: '0xabcdef1234',
                    operation: 'CALL',
                },
            ],
        },
        quote: {
            expectedOut: '260000000000000000',
            fee: '1000000',
            validUntil: Math.floor(Date.now() / 1000) + 300,
        },
        stakeSnapshot: { amount: '0' },
        signature: { type: 'EIP712_EOA', signer: wallet.address, sig: '0x5678' },
        ...overrides,
    };
}
describe('Policy Engine - Static Rules', () => {
    it('should PASS a valid intent + solution', async () => {
        const intent = makeIntent();
        const solution = makeSolution(intent);
        const result = await (0, policyEngine_1.validateSolution)(intent, solution);
        // R8 may produce WARN for non-whitelisted addresses, but should not FAIL
        expect(['PASS', 'WARN']).toContain(result.status);
        expect(result.findings.filter((f) => f.severity === 'CRITICAL')).toHaveLength(0);
    });
    it('should FAIL when intent deadline is expired', async () => {
        const intent = makeIntent({ deadline: Math.floor(Date.now() / 1000) - 100 });
        const solution = makeSolution(intent);
        const result = await (0, policyEngine_1.validateSolution)(intent, solution);
        expect(result.status).toBe('FAIL');
        expect(result.findings.some((f) => f.ruleId === 'R1')).toBe(true);
    });
    it('should FAIL when fee exceeds 5%', async () => {
        const intent = makeIntent();
        const solution = makeSolution(intent, {
            quote: {
                expectedOut: '100',
                fee: '10', // 10% fee
                validUntil: Math.floor(Date.now() / 1000) + 300,
            },
        });
        const result = await (0, policyEngine_1.validateSolution)(intent, solution);
        expect(result.status).toBe('FAIL');
        expect(result.findings.some((f) => f.ruleId === 'R4')).toBe(true);
    });
    it('should FAIL when blacklisted selector is used', async () => {
        const intent = makeIntent();
        const solution = makeSolution(intent, {
            executionPlan: {
                calls: [
                    {
                        to: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
                        value: '0',
                        data: '0x13af4035' + '0'.repeat(64), // setOwner selector
                        operation: 'CALL',
                    },
                ],
            },
        });
        const result = await (0, policyEngine_1.validateSolution)(intent, solution);
        expect(result.status).toBe('FAIL');
        expect(result.findings.some((f) => f.ruleId === 'R6')).toBe(true);
    });
    it('should FAIL when DELEGATECALL is used', async () => {
        const intent = makeIntent();
        const solution = makeSolution(intent, {
            executionPlan: {
                calls: [
                    {
                        to: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
                        value: '0',
                        data: '0xabcdef',
                        operation: 'DELEGATECALL',
                    },
                ],
            },
        });
        const result = await (0, policyEngine_1.validateSolution)(intent, solution);
        expect(result.status).toBe('FAIL');
        expect(result.findings.some((f) => f.ruleId === 'R11')).toBe(true);
    });
    it('should FAIL when slippage exceeds 10%', async () => {
        const intent = makeIntent({ constraints: { slippageBps: 1500 } });
        const solution = makeSolution(intent);
        const result = await (0, policyEngine_1.validateSolution)(intent, solution);
        expect(result.status).toBe('FAIL');
        expect(result.findings.some((f) => f.ruleId === 'R5')).toBe(true);
    });
    it('should WARN for non-whitelisted protocol', async () => {
        const intent = makeIntent();
        const solution = makeSolution(intent, {
            executionPlan: {
                calls: [
                    {
                        to: '0x1234567890123456789012345678901234567890', // unknown
                        value: '0',
                        data: '0xabcdef',
                        operation: 'CALL',
                    },
                ],
            },
        });
        const result = await (0, policyEngine_1.validateSolution)(intent, solution);
        // R8 is MEDIUM - should produce WARN not FAIL (unless other rules fail)
        const r8Finding = result.findings.find((f) => f.ruleId === 'R8');
        expect(r8Finding).toBeDefined();
        expect(r8Finding?.severity).toBe('MEDIUM');
    });
});
describe('Policy Engine - DeFi Skill Rules', () => {
    const ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
    const AAVE_WETH_GATEWAY = '0xD322A49006FC828F9B5B37Ab215F99B4E5caB19C';
    const ETH_DEPOSIT_AMOUNT = ethers_1.ethers.parseEther('0.5').toString(); // 500000000000000000
    function makeEthDepositIntent() {
        return makeIntent({
            input: { token: ETH_SENTINEL, amount: ETH_DEPOSIT_AMOUNT },
            outputs: [{ token: '0x0000000000000000000000000000000000000000', minAmount: ETH_DEPOSIT_AMOUNT }],
            constraints: { slippageBps: 0 },
            meta: {
                userIntentText: 'deposit 0.5 ETH to Aave',
                tags: ['DEPOSIT', 'ETH', 'aETH'],
                uiHints: { inputTokenSymbol: 'ETH', outputTokenSymbol: 'aETH', inputAmountHuman: '0.5', protocol: 'aave' },
            },
        });
    }
    it('R9 PASS — ETH DEPOSIT: ETH value equals input amount (no false positive)', async () => {
        const intent = makeEthDepositIntent();
        const solution = makeSolution(intent, {
            executionPlan: {
                calls: [
                    {
                        to: AAVE_WETH_GATEWAY,
                        value: ETH_DEPOSIT_AMOUNT, // ETH being deposited — should be allowed
                        data: '0x474cf53d' + '0'.repeat(128), // depositETH selector
                        operation: 'CALL',
                    },
                ],
            },
        });
        const result = await (0, policyEngine_1.validateSolution)(intent, solution);
        const r9 = result.findings.find((f) => f.ruleId === 'R9');
        expect(r9).toBeUndefined(); // R9 must not fire — ETH spend = input amount
    });
    it('R9 FAIL — ETH DEPOSIT: ETH value exceeds input amount', async () => {
        const intent = makeEthDepositIntent();
        const overSpend = (BigInt(ETH_DEPOSIT_AMOUNT) * 2n).toString();
        const solution = makeSolution(intent, {
            executionPlan: {
                calls: [
                    {
                        to: AAVE_WETH_GATEWAY,
                        value: overSpend, // 2x the deposit amount — suspicious
                        data: '0x474cf53d' + '0'.repeat(128),
                        operation: 'CALL',
                    },
                ],
            },
        });
        const result = await (0, policyEngine_1.validateSolution)(intent, solution);
        const r9 = result.findings.find((f) => f.ruleId === 'R9');
        expect(r9).toBeDefined(); // R9 must fire — over-spending
        expect(r9?.severity).toBe('HIGH');
    });
    it('R8 PASS — Aave v3 Pool is whitelisted (no warning)', async () => {
        const intent = makeIntent({
            meta: { userIntentText: 'deposit 100 USDC to Aave', tags: ['DEPOSIT', 'USDC', 'aUSDC'] },
        });
        const solution = makeSolution(intent, {
            executionPlan: {
                calls: [
                    {
                        to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC approve
                        value: '0',
                        data: '0x095ea7b3' + '0'.repeat(128),
                        operation: 'CALL',
                    },
                    {
                        to: AAVE_V3_POOL, // Pool.supply — whitelisted
                        value: '0',
                        data: '0x617ba037' + '0'.repeat(128),
                        operation: 'CALL',
                    },
                ],
            },
        });
        const result = await (0, policyEngine_1.validateSolution)(intent, solution);
        const r8 = result.findings.find((f) => f.ruleId === 'R8');
        expect(r8).toBeUndefined(); // Aave Pool is whitelisted — R8 must not fire
    });
});
describe('Policy Engine - Intent Pre-validation', () => {
    it('should PASS a valid intent', async () => {
        const intent = makeIntent();
        const result = await (0, policyEngine_1.validateIntent)(intent);
        expect(result.status).toBe('PASS');
    });
    it('should FAIL an expired intent', async () => {
        const intent = makeIntent({ deadline: Math.floor(Date.now() / 1000) - 1 });
        const result = await (0, policyEngine_1.validateIntent)(intent);
        expect(result.status).toBe('FAIL');
    });
});
//# sourceMappingURL=policy.test.js.map