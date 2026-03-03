import { ethers } from 'ethers';
import { buildSolutionFromCowQuote } from '../adapters/cowAdapter';
import { buildSafeTransaction } from '../adapters/safeAdapter';
import type { HIEFIntent, HIEFPolicyResult } from '@hief/common';
import type { CowQuote } from '../adapters/cowAdapter';

const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);

function makeIntent(overrides: Partial<HIEFIntent> = {}): HIEFIntent {
  const intentId = ethers.hexlify(ethers.randomBytes(32));
  return {
    intentVersion: '0.1',
    intentId,
    smartAccount: wallet.address,
    chainId: 8453,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    input: {
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      amount: '1000000000', // 1000 USDC
    },
    outputs: [
      {
        token: '0x4200000000000000000000000000000000000006', // WETH on Base
        minAmount: '250000000000000000', // 0.25 WETH
      },
    ],
    constraints: { slippageBps: 50 },
    priorityFee: { token: 'HIEF', amount: '0' },
    policyRef: { policyVersion: 'v0.1' },
    signature: { type: 'EIP712_EOA', signer: wallet.address, sig: '0x1234' },
    ...overrides,
  };
}

function makeCowQuote(overrides: Partial<CowQuote> = {}): CowQuote {
  return {
    sellToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    buyToken: '0x4200000000000000000000000000000000000006',
    sellAmount: '999000000',
    buyAmount: '260000000000000000',
    feeAmount: '1000000',
    validTo: Math.floor(Date.now() / 1000) + 300,
    appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
    kind: 'sell',
    partiallyFillable: false,
    quoteId: 12345,
    ...overrides,
  };
}

describe('CoW Adapter', () => {
  it('should build a valid HIEF solution from a CoW quote', () => {
    const intent = makeIntent();
    const quote = makeCowQuote();
    const solution = buildSolutionFromCowQuote(intent, quote, wallet.address);

    expect(solution.solutionVersion).toBe('0.1');
    expect(solution.intentId).toBe(intent.intentId);
    expect(solution.solverId).toBe(wallet.address);
    expect(solution.quote.expectedOut).toBe(quote.buyAmount);
    expect(solution.quote.fee).toBe(quote.feeAmount);
    expect(solution.executionPlan.calls.length).toBe(2); // approve + setPreSignature
  });

  it('should include approve call as first call', () => {
    const intent = makeIntent();
    const quote = makeCowQuote();
    const solution = buildSolutionFromCowQuote(intent, quote, wallet.address);

    const approveCall = solution.executionPlan.calls[0];
    expect(approveCall.to.toLowerCase()).toBe(intent.input.token.toLowerCase());
    expect(approveCall.operation).toBe('CALL');
    // Approve selector: 0x095ea7b3
    expect(approveCall.data.startsWith('0x095ea7b3')).toBe(true);
  });

  it('should include settlement call as second call', () => {
    const intent = makeIntent();
    const quote = makeCowQuote();
    const solution = buildSolutionFromCowQuote(intent, quote, wallet.address);

    const settlementCall = solution.executionPlan.calls[1];
    // CoW Settlement on Base
    expect(settlementCall.to.toLowerCase()).toBe('0x9008d19f58aabd9ed0d60971565aa8510560ab41');
    expect(settlementCall.operation).toBe('CALL');
  });

  it('should not include unlimited approval', () => {
    const intent = makeIntent();
    const quote = makeCowQuote();
    const solution = buildSolutionFromCowQuote(intent, quote, wallet.address);

    const approveCall = solution.executionPlan.calls[0];
    const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

    // Decode the approve call
    const iface = new ethers.Interface(['function approve(address spender, uint256 amount)']);
    const decoded = iface.decodeFunctionData('approve', approveCall.data);
    const amount = BigInt(decoded[1].toString());

    expect(amount).not.toBe(MAX_UINT256);
    // Should be exactly sellAmount + feeAmount
    const expectedAmount = BigInt(quote.sellAmount) + BigInt(quote.feeAmount);
    expect(amount).toBe(expectedAmount);
  });
});

describe('Safe Adapter', () => {
  it('should build a Safe transaction from a solution', async () => {
    const intent = makeIntent();
    const quote = makeCowQuote();
    const solution = buildSolutionFromCowQuote(intent, quote, wallet.address);
    solution.intentHash = ethers.hexlify(ethers.randomBytes(32));

    const mockPolicyResult: HIEFPolicyResult = {
      policyResultVersion: '0.1',
      policyRef: { policyVersion: 'v0.1' },
      intentHash: solution.intentHash,
      solutionId: solution.solutionId,
      status: 'PASS',
      findings: [],
      riskTags: [],
      summary: ['✅ PASS: All rules passed'],
      timestamp: Math.floor(Date.now() / 1000),
    };

    const result = await buildSafeTransaction(
      intent,
      solution,
      mockPolicyResult,
      wallet.address, // using wallet as mock safe address
      8453
    );

    expect(result.safeTxHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(result.planHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(result.safeAddress).toBe(wallet.address);
    expect(result.humanSummary).toContain('✅ PASS: All rules passed');
  });

  it('should use MultiSend for multiple calls', async () => {
    const intent = makeIntent();
    const quote = makeCowQuote();
    const solution = buildSolutionFromCowQuote(intent, quote, wallet.address);
    solution.intentHash = ethers.hexlify(ethers.randomBytes(32));

    const mockPolicyResult: HIEFPolicyResult = {
      policyResultVersion: '0.1',
      policyRef: { policyVersion: 'v0.1' },
      intentHash: solution.intentHash,
      solutionId: solution.solutionId,
      status: 'PASS',
      findings: [],
      riskTags: [],
      summary: ['✅ PASS'],
      timestamp: Math.floor(Date.now() / 1000),
    };

    // Solution has 2 calls (approve + setPreSignature)
    expect(solution.executionPlan.calls.length).toBe(2);

    const result = await buildSafeTransaction(
      intent,
      solution,
      mockPolicyResult,
      wallet.address,
      8453
    );

    // With 2 calls, should use MultiSend (DELEGATECALL = operation 1)
    expect(result.transaction.operation).toBe(1);
  });
});
