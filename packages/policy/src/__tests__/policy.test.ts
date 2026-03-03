import { ethers } from 'ethers';
import { validateSolution, validateIntent } from '../engine/policyEngine';
import type { HIEFIntent, HIEFSolution } from '@hief/common';

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

function makeSolution(intent: HIEFIntent, overrides: Partial<HIEFSolution> = {}): HIEFSolution {
  return {
    solutionVersion: '0.1',
    solutionId: ethers.hexlify(ethers.randomBytes(32)),
    intentId: intent.intentId,
    intentHash: ethers.hexlify(ethers.randomBytes(32)), // mock hash
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
    const result = await validateSolution(intent, solution);
    // R8 may produce WARN for non-whitelisted addresses, but should not FAIL
    expect(['PASS', 'WARN']).toContain(result.status);
    expect(result.findings.filter((f) => f.severity === 'CRITICAL')).toHaveLength(0);
  });

  it('should FAIL when intent deadline is expired', async () => {
    const intent = makeIntent({ deadline: Math.floor(Date.now() / 1000) - 100 });
    const solution = makeSolution(intent);
    const result = await validateSolution(intent, solution);
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
    const result = await validateSolution(intent, solution);
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
    const result = await validateSolution(intent, solution);
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
    const result = await validateSolution(intent, solution);
    expect(result.status).toBe('FAIL');
    expect(result.findings.some((f) => f.ruleId === 'R11')).toBe(true);
  });

  it('should FAIL when slippage exceeds 10%', async () => {
    const intent = makeIntent({ constraints: { slippageBps: 1500 } });
    const solution = makeSolution(intent);
    const result = await validateSolution(intent, solution);
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
    const result = await validateSolution(intent, solution);
    // R8 is MEDIUM - should produce WARN not FAIL (unless other rules fail)
    const r8Finding = result.findings.find((f) => f.ruleId === 'R8');
    expect(r8Finding).toBeDefined();
    expect(r8Finding?.severity).toBe('MEDIUM');
  });
});

describe('Policy Engine - Intent Pre-validation', () => {
  it('should PASS a valid intent', async () => {
    const intent = makeIntent();
    const result = await validateIntent(intent);
    expect(result.status).toBe('PASS');
  });

  it('should FAIL an expired intent', async () => {
    const intent = makeIntent({ deadline: Math.floor(Date.now() / 1000) - 1 });
    const result = await validateIntent(intent);
    expect(result.status).toBe('FAIL');
  });
});
