/**
 * DeFi Skills — Plugin registry for protocol adapters
 *
 * To add a new protocol (e.g. Compound v3, Lido):
 *   1. Implement DefiProtocolAdapter
 *   2. Register it: defiRegistry.register(new MyAdapter())
 *   3. Done — server.ts is fully protocol-agnostic via the registry
 *
 * Built-in adapters:
 *   - AaveV3Adapter: DEPOSIT + WITHDRAW on Ethereum mainnet / Tenderly fork
 */

import { ethers } from 'ethers';

// ─── Common Types ─────────────────────────────────────────────────────────────

export type DefiSkillType = 'DEPOSIT' | 'WITHDRAW' | 'STAKE' | 'UNSTAKE' | 'PROVIDE_LIQUIDITY';

/** The output of adapter.quote() — protocol-agnostic execution spec */
export interface DefiSkillQuote {
  protocol: string;           // human-readable name, e.g. 'Aave v3'
  adapterId: string;          // links back to the adapter for buildCalls dispatch
  skill: DefiSkillType;
  tokenIn: string;            // input token address (underlying for DEPOSIT; underlying for WITHDRAW)
  tokenOut: string;           // output token address (aToken for DEPOSIT; underlying for WITHDRAW)
  tokenOutSymbol: string;     // e.g. 'aUSDC', 'USDC'
  amountIn: bigint;
  amountOut: bigint;          // expected output (1:1 for Aave)
  apy: number;                // estimated APY % (0 for WITHDRAW)
  contractTo: string;         // contract to call
  calldata: string;           // encoded function call
  value: bigint;              // ETH msg.value (0 for ERC-20)
  needsApproval: boolean;     // true = caller must approve contractTo before calling
  approveTarget: string;      // spender for ERC-20 approve (empty if !needsApproval)
  /**
   * For WITHDRAW only: the receipt token (e.g. aUSDC) that will be burned.
   * Used by simulation auto-funding so the caller's aToken balance is set,
   * not the underlying (which the caller doesn't yet hold).
   */
  receiptTokenIn?: string;
  route: string;              // human-readable description
  priceImpactBps: number;     // always 0 for lending protocol interactions
}

/** Parameters passed to DefiProtocolAdapter.quote() */
export interface QuoteParams {
  skill: DefiSkillType;
  tokenIn: string;            // from intent.input.token (always underlying asset)
  amountIn: bigint;
  recipient: string;
  rpcUrl: string;
  chainId?: number;
}

export type CallData = { to: string; value: bigint; data: string };

// ─── Plugin Interface ─────────────────────────────────────────────────────────

/**
 * Implement this interface to add a new DeFi protocol to HIEF.
 * Register the adapter with defiRegistry.register(new YourAdapter()).
 */
export interface DefiProtocolAdapter {
  /** Unique stable ID, e.g. 'aave-v3', 'compound-v3', 'lido' */
  readonly id: string;
  /** Human-readable name, e.g. 'Aave v3' */
  readonly name: string;
  /** Short description shown in solver auction UI */
  readonly description: string;
  /** Chain IDs this adapter supports */
  readonly supportedChains: number[];
  /** Skill types this adapter supports */
  readonly supportedSkills: DefiSkillType[];

  /** Returns true if this adapter can handle (token, skill) */
  supportsToken(token: string, skill: DefiSkillType): boolean;

  /** Build a quote for the given intent parameters. Returns null if unsupported. */
  quote(params: QuoteParams): Promise<DefiSkillQuote | null>;

  /** Build on-chain call array from a settled quote (approve + execute) */
  buildCalls(quote: DefiSkillQuote): CallData[];
}

// ─── Registry ────────────────────────────────────────────────────────────────

export class DefiSkillRegistry {
  private adapters = new Map<string, DefiProtocolAdapter>();

  /** Register a new protocol adapter. Returns this for chaining. */
  register(adapter: DefiProtocolAdapter): this {
    this.adapters.set(adapter.id, adapter);
    console.log(`[DefiRegistry] + ${adapter.name} (${adapter.supportedSkills.join(', ')})`);
    return this;
  }

  unregister(id: string): void {
    this.adapters.delete(id);
  }

  getAll(): DefiProtocolAdapter[] {
    return Array.from(this.adapters.values());
  }

  getById(id: string): DefiProtocolAdapter | undefined {
    return this.adapters.get(id);
  }

  /** All adapters that support a given skill type */
  getForSkill(skill: DefiSkillType): DefiProtocolAdapter[] {
    return this.getAll().filter(a => a.supportedSkills.includes(skill));
  }

  /** All adapters that can quote (skill, token) */
  getForToken(token: string, skill: DefiSkillType): DefiProtocolAdapter[] {
    return this.getAll().filter(
      a => a.supportedSkills.includes(skill) && a.supportsToken(token, skill),
    );
  }

  /**
   * Build execution calls for a settled quote.
   * Dispatches to the originating adapter via quote.adapterId.
   * Falls back to generic approve + call if adapter is not found.
   */
  buildCalls(quote: DefiSkillQuote): CallData[] {
    const adapter = this.adapters.get(quote.adapterId);
    if (adapter) return adapter.buildCalls(quote);
    // Generic fallback
    const calls: CallData[] = [];
    if (quote.needsApproval) {
      const iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
      calls.push({
        to: quote.tokenIn,
        value: 0n,
        data: iface.encodeFunctionData('approve', [quote.approveTarget, quote.amountIn]),
      });
    }
    calls.push({ to: quote.contractTo, value: quote.value, data: quote.calldata });
    return calls;
  }
}

/** Singleton registry — import in server.ts and external adapters */
export const defiRegistry = new DefiSkillRegistry();

// ─── Aave v3 Adapter ─────────────────────────────────────────────────────────

export const ETH_ALIAS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const WETH_ADDR  = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const AAVE_V3_POOL      = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const AAVE_WETH_GATEWAY = '0xD322A49006FC828F9B5B37Ab215F99B4E5caB19C'; // WrappedTokenGatewayV3

/** underlying address → { aToken address, symbol, underlying } */
const AAVE_ATOKENS: Record<string, { aToken: string; symbol: string; underlying: string }> = {
  [WETH_ADDR.toLowerCase()]:                     { aToken: '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8', symbol: 'aWETH', underlying: WETH_ADDR },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':  { aToken: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c', symbol: 'aUSDC', underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  '0xdac17f958d2ee523a2206206994597c13d831ec7':  { aToken: '0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a', symbol: 'aUSDT', underlying: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
  '0x6b175474e89094c44da98b954eedeac495271d0f':  { aToken: '0x018008bfb33d285247A21d44E50697654f754e63', symbol: 'aDAI',  underlying: '0x6b175474e89094c44da98b954eedeac495271d0f' },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599':  { aToken: '0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8', symbol: 'aWBTC', underlying: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' },
};

/** aToken address → underlying address (reverse lookup) */
const ATOKEN_TO_UNDERLYING: Record<string, string> = Object.fromEntries(
  Object.entries(AAVE_ATOKENS).map(([underlying, { aToken }]) => [aToken.toLowerCase(), underlying]),
);

const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
];

const WETH_GATEWAY_ABI = [
  'function depositETH(address pool, address onBehalfOf, uint16 referralCode) payable',
  'function withdrawETH(address pool, uint256 amount, address to)',
];

export class AaveV3Adapter implements DefiProtocolAdapter {
  readonly id = 'aave-v3';
  readonly name = 'Aave v3';
  readonly description = 'Aave v3 lending protocol — earn yield by supplying assets, or withdraw your deposits.';
  readonly supportedChains = [1, 8453, 31337];
  readonly supportedSkills: DefiSkillType[] = ['DEPOSIT', 'WITHDRAW'];

  supportsToken(token: string, skill: DefiSkillType): boolean {
    const key = token.toLowerCase();
    if (skill === 'DEPOSIT') {
      return key === ETH_ALIAS.toLowerCase() || key in AAVE_ATOKENS;
    }
    if (skill === 'WITHDRAW') {
      // Accept underlying token address or aToken address
      return key in AAVE_ATOKENS || key in ATOKEN_TO_UNDERLYING;
    }
    return false;
  }

  async quote(params: QuoteParams): Promise<DefiSkillQuote | null> {
    if (params.skill === 'DEPOSIT') return this._quoteDeposit(params);
    if (params.skill === 'WITHDRAW') return this._quoteWithdraw(params);
    return null;
  }

  private async _quoteDeposit({ tokenIn, amountIn, recipient, rpcUrl }: QuoteParams): Promise<DefiSkillQuote | null> {
    try {
      const isEth     = tokenIn.toLowerCase() === ETH_ALIAS.toLowerCase();
      const assetAddr = isEth ? WETH_ADDR : tokenIn;
      const entry     = AAVE_ATOKENS[assetAddr.toLowerCase()];
      if (!entry) return null;

      const apy = await this._fetchApy(assetAddr, rpcUrl);

      let contractTo: string, calldata: string, value: bigint, needsApproval: boolean, approveTarget: string;

      if (isEth) {
        const iface = new ethers.Interface(WETH_GATEWAY_ABI);
        calldata      = iface.encodeFunctionData('depositETH', [AAVE_V3_POOL, recipient, 0]);
        contractTo    = AAVE_WETH_GATEWAY;
        value         = amountIn;
        needsApproval = false;
        approveTarget = '';
      } else {
        const iface = new ethers.Interface(AAVE_POOL_ABI);
        calldata      = iface.encodeFunctionData('supply', [assetAddr, amountIn, recipient, 0]);
        contractTo    = AAVE_V3_POOL;
        value         = 0n;
        needsApproval = true;
        approveTarget = AAVE_V3_POOL;
      }

      return {
        protocol: this.name, adapterId: this.id, skill: 'DEPOSIT',
        tokenIn: isEth ? ETH_ALIAS : tokenIn,
        tokenOut: entry.aToken, tokenOutSymbol: entry.symbol,
        amountIn, amountOut: amountIn, apy,
        contractTo, calldata, value, needsApproval, approveTarget,
        route: `Aave v3 Supply → ${entry.symbol} (${apy.toFixed(2)}% APY)`,
        priceImpactBps: 0,
      };
    } catch (e) {
      console.warn('[AaveV3] deposit quote error:', (e as Error).message?.slice(0, 120));
      return null;
    }
  }

  private async _quoteWithdraw({ tokenIn, amountIn, recipient, rpcUrl }: QuoteParams): Promise<DefiSkillQuote | null> {
    try {
      // tokenIn may be the underlying asset (USDC) or its aToken (aUSDC) — resolve to underlying
      const key = tokenIn.toLowerCase();
      const underlyingKey = key in AAVE_ATOKENS ? key
        : key in ATOKEN_TO_UNDERLYING ? ATOKEN_TO_UNDERLYING[key]
        : null;
      if (!underlyingKey) return null;

      const entry = AAVE_ATOKENS[underlyingKey];
      const underlyingAddr = entry.underlying;
      const isEth = underlyingKey === WETH_ADDR.toLowerCase();

      let contractTo: string, calldata: string, value: bigint;

      if (isEth) {
        // aWETH → ETH via WrappedTokenGatewayV3.withdrawETH
        // Note: caller must first approve gateway to spend aWETH
        const iface = new ethers.Interface(WETH_GATEWAY_ABI);
        calldata   = iface.encodeFunctionData('withdrawETH', [AAVE_V3_POOL, amountIn, recipient]);
        contractTo = AAVE_WETH_GATEWAY;
        value      = 0n;
      } else {
        // aToken → underlying via Pool.withdraw (pool burns aTokens from msg.sender, no approve needed)
        const iface = new ethers.Interface(AAVE_POOL_ABI);
        calldata   = iface.encodeFunctionData('withdraw', [underlyingAddr, amountIn, recipient]);
        contractTo = AAVE_V3_POOL;
        value      = 0n;
      }

      const underlyingSymbol = entry.symbol.replace(/^a/, '');  // 'aUSDC' → 'USDC'

      return {
        protocol: this.name, adapterId: this.id, skill: 'WITHDRAW',
        tokenIn: isEth ? ETH_ALIAS : underlyingAddr,
        tokenOut: isEth ? ETH_ALIAS : underlyingAddr,
        tokenOutSymbol: isEth ? 'ETH' : underlyingSymbol,
        amountIn, amountOut: amountIn, apy: 0,
        contractTo, calldata, value,
        needsApproval: isEth,    // withdrawETH: gateway calls aWETH.transferFrom — needs approve; Pool.withdraw burns directly — no approve
        approveTarget: isEth ? AAVE_WETH_GATEWAY : '',
        // receiptTokenIn: the aToken that will be burned on-chain (needed for simulation funding)
        receiptTokenIn: entry.aToken,
        route: `Aave v3 Withdraw ${entry.symbol} → ${isEth ? 'ETH' : underlyingSymbol}`,
        priceImpactBps: 0,
      };
    } catch (e) {
      console.warn('[AaveV3] withdraw quote error:', (e as Error).message?.slice(0, 120));
      return null;
    }
  }

  buildCalls(quote: DefiSkillQuote): CallData[] {
    const calls: CallData[] = [];
    if (quote.needsApproval) {
      const iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
      calls.push({
        to: quote.receiptTokenIn ?? quote.tokenIn,
        value: 0n,
        data: iface.encodeFunctionData('approve', [quote.approveTarget, quote.amountIn]),
      });
    }
    calls.push({ to: quote.contractTo, value: quote.value, data: quote.calldata });
    return calls;
  }

  private async _fetchApy(assetAddr: string, rpcUrl: string): Promise<number> {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const pool = new ethers.Contract(AAVE_V3_POOL, AAVE_POOL_ABI, provider);
      const reserve = await pool.getReserveData(assetAddr);
      return Number(BigInt(reserve.currentLiquidityRate)) / 1e25;
    } catch {
      return 0;
    }
  }
}

// ─── Lido Adapter ─────────────────────────────────────────────────────────────
//
// Lido stETH staking on Ethereum mainnet only.
//
// STAKE:   ETH → stETH  via Lido.submit(referral) payable
// UNSTAKE: stETH → ETH  via WithdrawalQueue.requestWithdrawals (ERC-4626-style)
//          Note: UNSTAKE queues a withdrawal request (not instant). Claim after ~1-4 days.
//
// Contracts (Ethereum mainnet):
//   Lido (stETH proxy):    0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84
//   WithdrawalQueueERC721: 0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1

const LIDO_STETH        = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
const LIDO_WITHDRAWAL_Q = '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1';

const LIDO_ABI = [
  'function submit(address _referral) external payable returns (uint256)',
  'function getPooledEthByShares(uint256 _sharesAmount) view returns (uint256)',
  // stETH as ERC-20 (for UNSTAKE approve)
  'function approve(address spender, uint256 amount) returns (bool)',
];

const LIDO_WITHDRAWAL_ABI = [
  'function requestWithdrawals(uint256[] calldata _amounts, address _owner) external returns (uint256[] memory requestIds)',
];

/** Fetch Lido current staking APR via Lido API */
async function _fetchLidoApr(): Promise<number> {
  try {
    const res = await fetch('https://eth-api.lido.fi/v1/protocol/steth/apr/last', {
      signal: AbortSignal.timeout(4000),
    });
    const json = await res.json() as { data?: { apr?: number } };
    return json?.data?.apr ?? 3.5;
  } catch {
    return 3.5; // fallback APR
  }
}

export class LidoAdapter implements DefiProtocolAdapter {
  readonly id = 'lido';
  readonly name = 'Lido';
  readonly description = 'Lido liquid staking — stake ETH to receive stETH and earn staking rewards.';
  readonly supportedChains = [1, 31337]; // Ethereum mainnet + local fork
  readonly supportedSkills: DefiSkillType[] = ['STAKE', 'UNSTAKE'];

  supportsToken(token: string, skill: DefiSkillType): boolean {
    const key = token.toLowerCase();
    if (skill === 'STAKE') {
      // Accept ETH (native or sentinel address)
      return key === ETH_ALIAS.toLowerCase() || key === '0x0000000000000000000000000000000000000000';
    }
    if (skill === 'UNSTAKE') {
      // Accept stETH
      return key === LIDO_STETH.toLowerCase();
    }
    return false;
  }

  async quote(params: QuoteParams): Promise<DefiSkillQuote | null> {
    if (params.skill === 'STAKE')   return this._quoteStake(params);
    if (params.skill === 'UNSTAKE') return this._quoteUnstake(params);
    return null;
  }

  private async _quoteStake({ tokenIn, amountIn, recipient }: QuoteParams): Promise<DefiSkillQuote | null> {
    try {
      const isEth = tokenIn.toLowerCase() === ETH_ALIAS.toLowerCase()
                 || tokenIn === '0x0000000000000000000000000000000000000000';
      if (!isEth) return null;

      const apr = await _fetchLidoApr();

      const iface = new ethers.Interface(LIDO_ABI);
      // referral = zero address (no referral)
      const calldata = iface.encodeFunctionData('submit', [ethers.ZeroAddress]);

      return {
        protocol: this.name, adapterId: this.id, skill: 'STAKE',
        tokenIn: ETH_ALIAS,
        tokenOut: LIDO_STETH, tokenOutSymbol: 'stETH',
        amountIn, amountOut: amountIn, // 1 ETH → ~1 stETH (rebasing token, 1:1 at mint)
        apy: apr,
        contractTo: LIDO_STETH,       // submit is on the stETH proxy contract
        calldata, value: amountIn,    // ETH sent as msg.value
        needsApproval: false,         // ETH STAKE needs no approve
        approveTarget: '',
        route: `Lido Stake ETH → stETH (${apr.toFixed(2)}% APR)`,
        priceImpactBps: 0,
      };
    } catch (e) {
      console.warn('[Lido] stake quote error:', (e as Error).message?.slice(0, 120));
      return null;
    }
  }

  private async _quoteUnstake({ tokenIn, amountIn, recipient }: QuoteParams): Promise<DefiSkillQuote | null> {
    try {
      const isStEth = tokenIn.toLowerCase() === LIDO_STETH.toLowerCase();
      if (!isStEth) return null;

      // WithdrawalQueue.requestWithdrawals([amount], owner)
      const iface = new ethers.Interface(LIDO_WITHDRAWAL_ABI);
      const calldata = iface.encodeFunctionData('requestWithdrawals', [[amountIn], recipient]);

      return {
        protocol: this.name, adapterId: this.id, skill: 'UNSTAKE',
        tokenIn: LIDO_STETH,
        tokenOut: ETH_ALIAS, tokenOutSymbol: 'ETH',
        amountIn, amountOut: amountIn,
        apy: 0,
        contractTo: LIDO_WITHDRAWAL_Q,
        calldata, value: 0n,
        needsApproval: true,          // WithdrawalQueue calls stETH.transferFrom
        approveTarget: LIDO_WITHDRAWAL_Q,
        receiptTokenIn: LIDO_STETH,   // stETH is burned / transferred
        route: 'Lido Unstake stETH → ETH (withdrawal queue, ~1-4 days)',
        priceImpactBps: 0,
      };
    } catch (e) {
      console.warn('[Lido] unstake quote error:', (e as Error).message?.slice(0, 120));
      return null;
    }
  }

  buildCalls(quote: DefiSkillQuote): CallData[] {
    const calls: CallData[] = [];
    if (quote.needsApproval) {
      const iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
      calls.push({
        to: quote.receiptTokenIn ?? quote.tokenIn,
        value: 0n,
        data: iface.encodeFunctionData('approve', [quote.approveTarget, quote.amountIn]),
      });
    }
    calls.push({ to: quote.contractTo, value: quote.value, data: quote.calldata });
    return calls;
  }
}

// ─── Register built-in adapters ───────────────────────────────────────────────
// External adapters can be registered by importing defiRegistry and calling register().

defiRegistry.register(new AaveV3Adapter());
defiRegistry.register(new LidoAdapter());

// ─── Legacy exports (backward compatibility) ──────────────────────────────────

/** @deprecated Use defiRegistry.getById('aave-v3')!.quote(...) instead */
export async function quoteAaveDeposit(
  tokenIn: string, amountIn: bigint, recipient: string, rpcUrl: string,
): Promise<DefiSkillQuote | null> {
  return defiRegistry.getById('aave-v3')!.quote({ skill: 'DEPOSIT', tokenIn, amountIn, recipient, rpcUrl });
}

/** @deprecated Use defiRegistry.buildCalls(quote) instead */
export function buildAaveDepositCalls(skill: DefiSkillQuote): CallData[] {
  return defiRegistry.buildCalls(skill);
}
