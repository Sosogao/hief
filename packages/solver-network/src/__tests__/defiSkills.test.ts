/**
 * defiSkills.ts Unit Tests
 *
 * Tests the plugin registry and AaveV3Adapter without any live RPC calls.
 * _fetchApy is spied on and returns a fixed value so all quote() tests are deterministic.
 */

import { ethers } from 'ethers';
import {
  DefiSkillRegistry,
  AaveV3Adapter,
  LidoAdapter,
  defiRegistry,
  ETH_ALIAS,
  WETH_ADDR,
  type DefiSkillQuote,
  type DefiProtocolAdapter,
  type DefiSkillType,
  type QuoteParams,
  type CallData,
} from '../defiSkills';

// ─── Constants ────────────────────────────────────────────────────────────────

const AAVE_V3_POOL      = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const AAVE_WETH_GATEWAY = '0xD322A49006FC828F9B5B37Ab215F99B4E5caB19C';

const USDC_ADDR = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const AUSDC_ADDR = '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c';
const AWETH_ADDR = '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8';

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const MOCK_RPC   = 'http://localhost:8545';

// ─── DefiSkillRegistry ────────────────────────────────────────────────────────

describe('DefiSkillRegistry', () => {
  let registry: DefiSkillRegistry;

  beforeEach(() => {
    registry = new DefiSkillRegistry();
  });

  test('register and getAll', () => {
    const adapter = new AaveV3Adapter();
    registry.register(adapter);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getAll()[0].id).toBe('aave-v3');
  });

  test('getById returns registered adapter', () => {
    registry.register(new AaveV3Adapter());
    expect(registry.getById('aave-v3')).toBeDefined();
    expect(registry.getById('nonexistent')).toBeUndefined();
  });

  test('getForSkill filters correctly', () => {
    registry.register(new AaveV3Adapter());
    expect(registry.getForSkill('DEPOSIT')).toHaveLength(1);
    expect(registry.getForSkill('STAKE')).toHaveLength(0);
    expect(registry.getForSkill('WITHDRAW')).toHaveLength(1);
  });

  test('getForToken returns adapters that support (token, skill)', () => {
    registry.register(new AaveV3Adapter());
    expect(registry.getForToken(USDC_ADDR, 'DEPOSIT')).toHaveLength(1);
    expect(registry.getForToken(ETH_ALIAS, 'DEPOSIT')).toHaveLength(1);
    expect(registry.getForToken('0xdeadbeef00000000000000000000000000000001', 'DEPOSIT')).toHaveLength(0);
    expect(registry.getForToken(USDC_ADDR, 'STAKE')).toHaveLength(0);
  });

  test('unregister removes adapter', () => {
    registry.register(new AaveV3Adapter());
    registry.unregister('aave-v3');
    expect(registry.getAll()).toHaveLength(0);
  });

  test('buildCalls dispatches to adapter (ERC-20 DEPOSIT)', () => {
    registry.register(new AaveV3Adapter());
    const quote: DefiSkillQuote = {
      protocol: 'Aave v3', adapterId: 'aave-v3', skill: 'DEPOSIT',
      tokenIn: USDC_ADDR, tokenOut: AUSDC_ADDR, tokenOutSymbol: 'aUSDC',
      amountIn: 100_000_000n, amountOut: 100_000_000n, apy: 5,
      contractTo: AAVE_V3_POOL,
      calldata: '0x617ba037' + '0'.repeat(192), // placeholder
      value: 0n, needsApproval: true, approveTarget: AAVE_V3_POOL,
      route: 'Aave v3 Supply → aUSDC', priceImpactBps: 0,
    };
    const calls = registry.buildCalls(quote);
    expect(calls).toHaveLength(2); // approve + supply
    expect(calls[0].to).toBe(USDC_ADDR);   // approve target is the token
    expect(calls[1].to).toBe(AAVE_V3_POOL);
  });

  test('buildCalls generic fallback when adapter not found', () => {
    // Don't register any adapter
    const quote: DefiSkillQuote = {
      protocol: 'Unknown', adapterId: 'unknown-protocol', skill: 'DEPOSIT',
      tokenIn: USDC_ADDR, tokenOut: AUSDC_ADDR, tokenOutSymbol: 'aUSDC',
      amountIn: 100_000_000n, amountOut: 100_000_000n, apy: 0,
      contractTo: '0x1234567890123456789012345678901234567890',
      calldata: '0xabcdef', value: 0n,
      needsApproval: true, approveTarget: '0x1234567890123456789012345678901234567890',
      route: 'Unknown', priceImpactBps: 0,
    };
    const calls = registry.buildCalls(quote);
    expect(calls).toHaveLength(2); // approve + call
  });
});

// ─── AaveV3Adapter — supportsToken ───────────────────────────────────────────

describe('AaveV3Adapter.supportsToken', () => {
  let adapter: AaveV3Adapter;

  beforeEach(() => { adapter = new AaveV3Adapter(); });

  test('DEPOSIT: accepts ETH alias', () => {
    expect(adapter.supportsToken(ETH_ALIAS, 'DEPOSIT')).toBe(true);
  });

  test('DEPOSIT: accepts USDC (underlying)', () => {
    expect(adapter.supportsToken(USDC_ADDR, 'DEPOSIT')).toBe(true);
  });

  test('DEPOSIT: accepts WETH', () => {
    expect(adapter.supportsToken(WETH_ADDR, 'DEPOSIT')).toBe(true);
  });

  test('DEPOSIT: rejects unknown token', () => {
    expect(adapter.supportsToken('0xdeadbeef00000000000000000000000000000001', 'DEPOSIT')).toBe(false);
  });

  test('DEPOSIT: rejects STAKE skill', () => {
    expect(adapter.supportsToken(USDC_ADDR, 'STAKE')).toBe(false);
  });

  test('WITHDRAW: accepts underlying (USDC)', () => {
    expect(adapter.supportsToken(USDC_ADDR, 'WITHDRAW')).toBe(true);
  });

  test('WITHDRAW: accepts aToken address (aUSDC)', () => {
    expect(adapter.supportsToken(AUSDC_ADDR, 'WITHDRAW')).toBe(true);
  });

  test('WITHDRAW: rejects unknown token', () => {
    expect(adapter.supportsToken('0xdeadbeef00000000000000000000000000000001', 'WITHDRAW')).toBe(false);
  });

  test('supportsToken is case-insensitive', () => {
    expect(adapter.supportsToken(USDC_ADDR.toUpperCase(), 'DEPOSIT')).toBe(true);
    expect(adapter.supportsToken(AUSDC_ADDR.toUpperCase(), 'WITHDRAW')).toBe(true);
  });
});

// ─── AaveV3Adapter — buildCalls ──────────────────────────────────────────────

describe('AaveV3Adapter.buildCalls', () => {
  let adapter: AaveV3Adapter;

  beforeEach(() => { adapter = new AaveV3Adapter(); });

  test('DEPOSIT ERC-20: approve USDC then supply to Pool', () => {
    const quote: DefiSkillQuote = {
      protocol: 'Aave v3', adapterId: 'aave-v3', skill: 'DEPOSIT',
      tokenIn: USDC_ADDR, tokenOut: AUSDC_ADDR, tokenOutSymbol: 'aUSDC',
      amountIn: 100_000_000n, amountOut: 100_000_000n, apy: 4.2,
      contractTo: AAVE_V3_POOL,
      calldata: new ethers.Interface(['function supply(address,uint256,address,uint16)']).encodeFunctionData('supply', [USDC_ADDR, 100_000_000n, RECIPIENT, 0]),
      value: 0n, needsApproval: true, approveTarget: AAVE_V3_POOL,
      route: 'Aave v3 Supply → aUSDC', priceImpactBps: 0,
    };
    const calls = adapter.buildCalls(quote);
    expect(calls).toHaveLength(2);
    // Call[0]: approve(Pool, amount) on USDC contract
    expect(calls[0].to).toBe(USDC_ADDR);
    expect(calls[0].value).toBe(0n);
    expect(calls[0].data).toContain('095ea7b3'); // approve selector
    // Call[1]: Pool.supply
    expect(calls[1].to).toBe(AAVE_V3_POOL);
    expect(calls[1].value).toBe(0n);
  });

  test('DEPOSIT ETH: no approve, depositETH with value', () => {
    const amount = ethers.parseEther('1');
    const quote: DefiSkillQuote = {
      protocol: 'Aave v3', adapterId: 'aave-v3', skill: 'DEPOSIT',
      tokenIn: ETH_ALIAS, tokenOut: AWETH_ADDR, tokenOutSymbol: 'aWETH',
      amountIn: amount, amountOut: amount, apy: 3.1,
      contractTo: AAVE_WETH_GATEWAY,
      calldata: new ethers.Interface(['function depositETH(address,address,uint16) payable']).encodeFunctionData('depositETH', [AAVE_V3_POOL, RECIPIENT, 0]),
      value: amount, needsApproval: false, approveTarget: '',
      route: 'Aave v3 Supply ETH → aWETH', priceImpactBps: 0,
    };
    const calls = adapter.buildCalls(quote);
    expect(calls).toHaveLength(1); // no approve
    expect(calls[0].to).toBe(AAVE_WETH_GATEWAY);
    expect(calls[0].value).toBe(amount);
  });

  test('WITHDRAW ERC-20: no approve, Pool.withdraw', () => {
    const amount = 50_000_000n;
    const quote: DefiSkillQuote = {
      protocol: 'Aave v3', adapterId: 'aave-v3', skill: 'WITHDRAW',
      tokenIn: USDC_ADDR, tokenOut: USDC_ADDR, tokenOutSymbol: 'USDC',
      amountIn: amount, amountOut: amount, apy: 0,
      contractTo: AAVE_V3_POOL,
      calldata: new ethers.Interface(['function withdraw(address,uint256,address) returns (uint256)']).encodeFunctionData('withdraw', [USDC_ADDR, amount, RECIPIENT]),
      value: 0n, needsApproval: false, approveTarget: '',
      receiptTokenIn: AUSDC_ADDR,
      route: 'Aave v3 Withdraw aUSDC → USDC', priceImpactBps: 0,
    };
    const calls = adapter.buildCalls(quote);
    expect(calls).toHaveLength(1); // no approve — Pool burns aTokens from msg.sender
    expect(calls[0].to).toBe(AAVE_V3_POOL);
    expect(calls[0].value).toBe(0n);
  });

  test('WITHDRAW ETH: approve aWETH to gateway, then withdrawETH', () => {
    const amount = ethers.parseEther('0.5');
    const quote: DefiSkillQuote = {
      protocol: 'Aave v3', adapterId: 'aave-v3', skill: 'WITHDRAW',
      tokenIn: ETH_ALIAS, tokenOut: ETH_ALIAS, tokenOutSymbol: 'ETH',
      amountIn: amount, amountOut: amount, apy: 0,
      contractTo: AAVE_WETH_GATEWAY,
      calldata: new ethers.Interface(['function withdrawETH(address,uint256,address)']).encodeFunctionData('withdrawETH', [AAVE_V3_POOL, amount, RECIPIENT]),
      value: 0n, needsApproval: true, approveTarget: AAVE_WETH_GATEWAY,
      receiptTokenIn: AWETH_ADDR,
      route: 'Aave v3 Withdraw aWETH → ETH', priceImpactBps: 0,
    };
    const calls = adapter.buildCalls(quote);
    expect(calls).toHaveLength(2); // approve aWETH + withdrawETH
    // approve: target token is aWETH (receiptTokenIn), spender is gateway
    expect(calls[0].to).toBe(AWETH_ADDR);
    expect(calls[0].data).toContain('095ea7b3');
    expect(calls[1].to).toBe(AAVE_WETH_GATEWAY);
  });
});

// ─── AaveV3Adapter — quote() (mocked APY) ────────────────────────────────────

describe('AaveV3Adapter.quote', () => {
  let adapter: AaveV3Adapter;

  beforeEach(() => {
    adapter = new AaveV3Adapter();
    // Mock _fetchApy to avoid real RPC calls
    jest.spyOn(adapter as any, '_fetchApy').mockResolvedValue(4.5);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  const baseParams = (overrides: Partial<QuoteParams> = {}): QuoteParams => ({
    skill: 'DEPOSIT',
    tokenIn: USDC_ADDR,
    amountIn: 100_000_000n,
    recipient: RECIPIENT,
    rpcUrl: MOCK_RPC,
    chainId: 1,
    ...overrides,
  });

  test('DEPOSIT USDC: returns valid quote with approve + Pool.supply', async () => {
    const q = await adapter.quote(baseParams());
    expect(q).not.toBeNull();
    expect(q!.skill).toBe('DEPOSIT');
    expect(q!.adapterId).toBe('aave-v3');
    expect(q!.tokenIn.toLowerCase()).toBe(USDC_ADDR.toLowerCase());
    expect(q!.tokenOut.toLowerCase()).toBe(AUSDC_ADDR.toLowerCase());
    expect(q!.tokenOutSymbol).toBe('aUSDC');
    expect(q!.amountIn).toBe(100_000_000n);
    expect(q!.amountOut).toBe(100_000_000n); // 1:1 lending
    expect(q!.apy).toBe(4.5);
    expect(q!.needsApproval).toBe(true);
    expect(q!.approveTarget).toBe(AAVE_V3_POOL);
    expect(q!.contractTo).toBe(AAVE_V3_POOL);
    expect(q!.value).toBe(0n);
    expect(q!.priceImpactBps).toBe(0);
  });

  test('DEPOSIT ETH: uses WETHGateway, value = amountIn, no approval', async () => {
    const amount = ethers.parseEther('0.5');
    const q = await adapter.quote(baseParams({ tokenIn: ETH_ALIAS, amountIn: amount }));
    expect(q).not.toBeNull();
    expect(q!.tokenIn).toBe(ETH_ALIAS);
    expect(q!.tokenOut.toLowerCase()).toBe(AWETH_ADDR.toLowerCase());
    expect(q!.tokenOutSymbol).toBe('aWETH');
    expect(q!.contractTo).toBe(AAVE_WETH_GATEWAY);
    expect(q!.value).toBe(amount);
    expect(q!.needsApproval).toBe(false);
    expect(q!.approveTarget).toBe('');
  });

  test('WITHDRAW USDC: no approval, Pool.withdraw, receiptTokenIn = aUSDC', async () => {
    const q = await adapter.quote(baseParams({ skill: 'WITHDRAW', tokenIn: USDC_ADDR }));
    expect(q).not.toBeNull();
    expect(q!.skill).toBe('WITHDRAW');
    expect(q!.needsApproval).toBe(false);   // Pool burns aTokens directly
    expect(q!.contractTo).toBe(AAVE_V3_POOL);
    expect(q!.receiptTokenIn?.toLowerCase()).toBe(AUSDC_ADDR.toLowerCase());
    expect(q!.value).toBe(0n);
  });

  test('WITHDRAW accepts aToken address as tokenIn', async () => {
    // User may specify aUSDC instead of USDC as the withdrawal token
    const q = await adapter.quote(baseParams({ skill: 'WITHDRAW', tokenIn: AUSDC_ADDR }));
    expect(q).not.toBeNull();
    expect(q!.tokenOutSymbol).toBe('USDC');
    expect(q!.receiptTokenIn?.toLowerCase()).toBe(AUSDC_ADDR.toLowerCase());
  });

  test('WITHDRAW ETH (via aWETH): approval needed, uses WETHGateway', async () => {
    const amount = ethers.parseEther('1');
    const q = await adapter.quote(baseParams({ skill: 'WITHDRAW', tokenIn: WETH_ADDR, amountIn: amount }));
    expect(q).not.toBeNull();
    expect(q!.needsApproval).toBe(true);    // Gateway calls aWETH.transferFrom
    expect(q!.approveTarget).toBe(AAVE_WETH_GATEWAY);
    expect(q!.contractTo).toBe(AAVE_WETH_GATEWAY);
    expect(q!.receiptTokenIn?.toLowerCase()).toBe(AWETH_ADDR.toLowerCase());
  });

  test('DEPOSIT unsupported token returns null', async () => {
    const q = await adapter.quote(baseParams({ tokenIn: '0xdeadbeef00000000000000000000000000000001' }));
    expect(q).toBeNull();
  });

  test('STAKE returns null (unsupported skill)', async () => {
    const q = await adapter.quote(baseParams({ skill: 'STAKE' }));
    expect(q).toBeNull();
  });

  test('DEPOSIT calldata encodes supply(asset, amount, recipient, 0)', async () => {
    const q = await adapter.quote(baseParams());
    expect(q).not.toBeNull();
    // Decode calldata and verify parameters
    const iface = new ethers.Interface(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)']);
    const decoded = iface.decodeFunctionData('supply', q!.calldata);
    expect(decoded[0].toLowerCase()).toBe(USDC_ADDR.toLowerCase());   // asset
    expect(decoded[1]).toBe(100_000_000n);                             // amount
    expect(decoded[2].toLowerCase()).toBe(RECIPIENT.toLowerCase());    // onBehalfOf
    expect(decoded[3]).toBe(0n);                                       // referralCode
  });

  test('WITHDRAW calldata encodes withdraw(asset, amount, recipient)', async () => {
    const q = await adapter.quote(baseParams({ skill: 'WITHDRAW', tokenIn: USDC_ADDR }));
    expect(q).not.toBeNull();
    const iface = new ethers.Interface(['function withdraw(address asset, uint256 amount, address to) returns (uint256)']);
    const decoded = iface.decodeFunctionData('withdraw', q!.calldata);
    expect(decoded[0].toLowerCase()).toBe(USDC_ADDR.toLowerCase()); // asset (underlying)
    expect(decoded[1]).toBe(100_000_000n);                           // amount
    expect(decoded[2].toLowerCase()).toBe(RECIPIENT.toLowerCase()); // to
  });
});

// ─── LidoAdapter ─────────────────────────────────────────────────────────────

const LIDO_STETH        = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
const LIDO_WITHDRAWAL_Q = '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1';

describe('LidoAdapter.supportsToken', () => {
  let adapter: LidoAdapter;
  beforeEach(() => { adapter = new LidoAdapter(); });

  test('STAKE: accepts ETH alias', () => {
    expect(adapter.supportsToken(ETH_ALIAS, 'STAKE')).toBe(true);
  });

  test('STAKE: accepts zero address (native ETH)', () => {
    expect(adapter.supportsToken('0x0000000000000000000000000000000000000000', 'STAKE')).toBe(true);
  });

  test('STAKE: rejects non-ETH tokens', () => {
    expect(adapter.supportsToken(USDC_ADDR, 'STAKE')).toBe(false);
    expect(adapter.supportsToken(WETH_ADDR, 'STAKE')).toBe(false);
  });

  test('UNSTAKE: accepts stETH', () => {
    expect(adapter.supportsToken(LIDO_STETH, 'UNSTAKE')).toBe(true);
  });

  test('UNSTAKE: rejects ETH / other tokens', () => {
    expect(adapter.supportsToken(ETH_ALIAS, 'UNSTAKE')).toBe(false);
    expect(adapter.supportsToken(USDC_ADDR, 'UNSTAKE')).toBe(false);
  });

  test('DEPOSIT/WITHDRAW: not supported by Lido', () => {
    expect(adapter.supportsToken(ETH_ALIAS, 'DEPOSIT')).toBe(false);
    expect(adapter.supportsToken(LIDO_STETH, 'WITHDRAW')).toBe(false);
  });
});

describe('LidoAdapter.quote', () => {
  let adapter: LidoAdapter;

  beforeEach(() => {
    adapter = new LidoAdapter();
    // Mock the module-level _fetchLidoApr by mocking global fetch
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ data: { apr: 3.8 } }),
    }) as any;
  });

  afterEach(() => { jest.restoreAllMocks(); });

  const stakeParams = (overrides: Partial<QuoteParams> = {}): QuoteParams => ({
    skill: 'STAKE',
    tokenIn: ETH_ALIAS,
    amountIn: ethers.parseEther('1'),
    recipient: RECIPIENT,
    rpcUrl: MOCK_RPC,
    chainId: 1,
    ...overrides,
  });

  test('STAKE ETH: sends to stETH contract with value, no approval', async () => {
    const amount = ethers.parseEther('1');
    const q = await adapter.quote(stakeParams({ amountIn: amount }));
    expect(q).not.toBeNull();
    expect(q!.skill).toBe('STAKE');
    expect(q!.adapterId).toBe('lido');
    expect(q!.tokenIn).toBe(ETH_ALIAS);
    expect(q!.tokenOut.toLowerCase()).toBe(LIDO_STETH.toLowerCase());
    expect(q!.tokenOutSymbol).toBe('stETH');
    expect(q!.amountIn).toBe(amount);
    expect(q!.amountOut).toBe(amount);     // 1:1 at mint
    expect(q!.apy).toBe(3.8);             // from mocked fetch
    expect(q!.contractTo.toLowerCase()).toBe(LIDO_STETH.toLowerCase());
    expect(q!.value).toBe(amount);         // ETH sent as msg.value
    expect(q!.needsApproval).toBe(false);
    expect(q!.priceImpactBps).toBe(0);
  });

  test('STAKE: calldata encodes submit(zeroAddress)', async () => {
    const q = await adapter.quote(stakeParams());
    expect(q).not.toBeNull();
    const iface = new ethers.Interface(['function submit(address _referral) external payable returns (uint256)']);
    const decoded = iface.decodeFunctionData('submit', q!.calldata);
    expect(decoded[0]).toBe(ethers.ZeroAddress);
  });

  test('STAKE: returns null for non-ETH token', async () => {
    const q = await adapter.quote(stakeParams({ tokenIn: USDC_ADDR }));
    expect(q).toBeNull();
  });

  test('UNSTAKE stETH: approve + requestWithdrawals', async () => {
    const amount = ethers.parseEther('0.5');
    const q = await adapter.quote(stakeParams({ skill: 'UNSTAKE', tokenIn: LIDO_STETH, amountIn: amount }));
    expect(q).not.toBeNull();
    expect(q!.skill).toBe('UNSTAKE');
    expect(q!.tokenIn.toLowerCase()).toBe(LIDO_STETH.toLowerCase());
    expect(q!.tokenOut).toBe(ETH_ALIAS);
    expect(q!.tokenOutSymbol).toBe('ETH');
    expect(q!.contractTo.toLowerCase()).toBe(LIDO_WITHDRAWAL_Q.toLowerCase());
    expect(q!.value).toBe(0n);
    expect(q!.needsApproval).toBe(true);
    expect(q!.approveTarget.toLowerCase()).toBe(LIDO_WITHDRAWAL_Q.toLowerCase());
    expect(q!.receiptTokenIn?.toLowerCase()).toBe(LIDO_STETH.toLowerCase());
    expect(q!.apy).toBe(0); // withdrawal has no yield
  });

  test('DEPOSIT/WITHDRAW returns null for Lido', async () => {
    expect(await adapter.quote(stakeParams({ skill: 'DEPOSIT' }))).toBeNull();
    expect(await adapter.quote(stakeParams({ skill: 'WITHDRAW', tokenIn: LIDO_STETH }))).toBeNull();
  });
});

describe('LidoAdapter.buildCalls', () => {
  let adapter: LidoAdapter;
  beforeEach(() => { adapter = new LidoAdapter(); });

  test('STAKE: single call with ETH value', () => {
    const amount = ethers.parseEther('1');
    const quote: DefiSkillQuote = {
      protocol: 'Lido', adapterId: 'lido', skill: 'STAKE',
      tokenIn: ETH_ALIAS, tokenOut: LIDO_STETH, tokenOutSymbol: 'stETH',
      amountIn: amount, amountOut: amount, apy: 3.8,
      contractTo: LIDO_STETH,
      calldata: new ethers.Interface(['function submit(address) payable returns (uint256)']).encodeFunctionData('submit', [ethers.ZeroAddress]),
      value: amount, needsApproval: false, approveTarget: '',
      route: 'Lido Stake ETH → stETH', priceImpactBps: 0,
    };
    const calls = adapter.buildCalls(quote);
    expect(calls).toHaveLength(1);
    expect(calls[0].to.toLowerCase()).toBe(LIDO_STETH.toLowerCase());
    expect(calls[0].value).toBe(amount);
  });

  test('UNSTAKE: approve stETH to WithdrawalQueue + requestWithdrawals', () => {
    const amount = ethers.parseEther('0.5');
    const quote: DefiSkillQuote = {
      protocol: 'Lido', adapterId: 'lido', skill: 'UNSTAKE',
      tokenIn: LIDO_STETH, tokenOut: ETH_ALIAS, tokenOutSymbol: 'ETH',
      amountIn: amount, amountOut: amount, apy: 0,
      contractTo: LIDO_WITHDRAWAL_Q,
      calldata: '0xabcdef',
      value: 0n, needsApproval: true, approveTarget: LIDO_WITHDRAWAL_Q,
      receiptTokenIn: LIDO_STETH,
      route: 'Lido Unstake stETH → ETH', priceImpactBps: 0,
    };
    const calls = adapter.buildCalls(quote);
    expect(calls).toHaveLength(2);
    // approve: stETH.approve(WithdrawalQueue, amount)
    expect(calls[0].to.toLowerCase()).toBe(LIDO_STETH.toLowerCase());
    expect(calls[0].data).toContain('095ea7b3');
    expect(calls[1].to.toLowerCase()).toBe(LIDO_WITHDRAWAL_Q.toLowerCase());
  });
});

// ─── Global registry (sanity check) ─────────────────────────────────────────

describe('Global defiRegistry', () => {
  test('has AaveV3Adapter pre-registered', () => {
    const aave = defiRegistry.getById('aave-v3');
    expect(aave).toBeDefined();
    expect(aave!.supportedSkills).toContain('DEPOSIT');
    expect(aave!.supportedSkills).toContain('WITHDRAW');
    expect(aave!.supportedChains).toContain(1);
  });

  test('has LidoAdapter pre-registered', () => {
    const lido = defiRegistry.getById('lido');
    expect(lido).toBeDefined();
    expect(lido!.supportedSkills).toContain('STAKE');
    expect(lido!.supportedSkills).toContain('UNSTAKE');
    expect(lido!.supportedChains).toContain(1);
  });

  test('getForSkill STAKE returns only Lido (not Aave)', () => {
    const stakers = defiRegistry.getForSkill('STAKE');
    expect(stakers.map(a => a.id)).toContain('lido');
    expect(stakers.map(a => a.id)).not.toContain('aave-v3');
  });

  test('getForToken ETH/STAKE returns Lido', () => {
    expect(defiRegistry.getForToken(ETH_ALIAS, 'STAKE').map(a => a.id)).toContain('lido');
  });
});
