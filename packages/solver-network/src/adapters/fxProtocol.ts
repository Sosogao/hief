/**
 * f(x) Protocol fxSAVE + Leverage Adapter
 *
 * Integrates f(x) Protocol into HIEF via the @aladdindao/fx-sdk.
 * Upstream skill reference: https://github.com/AladdinDAO/fx-sdk-skill
 *
 * Supported skills:
 *   DEPOSIT        — deposit USDC into fxSAVE → receive fxSAVE shares
 *   WITHDRAW       — instant redeem fxSAVE shares → USDC (fee applies)
 *   LEVERAGE_LONG  — open/increase leveraged long position (wstETH/WBTC collateral)
 *   LEVERAGE_SHORT — open/increase leveraged short position (wstETH/WBTC collateral)
 *   LEVERAGE_CLOSE — close/reduce a leveraged position
 *
 * Adaptive routing:
 *   routingMode === 'FORK'    → targets = [FX_ROUTE, FX_ROUTE_V3] (no external aggregator APIs)
 *   routingMode === 'MAINNET' → targets = undefined (SDK picks best: Velora/Odos/FxRoute)
 */

import { ethers } from 'ethers';
import { FxSdk } from '@aladdindao/fx-sdk';

// ROUTE_TYPES is declared but not exported by @aladdindao/fx-sdk.
// Use string literal values directly (matching the enum at runtime).
const FX_ROUTE   = 'FxRoute'   as const;
const FX_ROUTE_V3 = 'FxRoute 2' as const;
import {
  type DefiProtocolAdapter,
  type DefiSkillType,
  type QuoteParams,
  type DefiSkillQuote,
  type CallData,
} from '../defiSkills';

// ─── Constants ────────────────────────────────────────────────────────────────

const USDC_ADDRESS       = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_ADDRESS_LOWER = USDC_ADDRESS.toLowerCase();
const FXUSD_ADDRESS      = '0x085780639CC2cACd35E474e71f4d000e2405d8f6';
const WSTETH_ADDRESS     = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const WBTC_ADDRESS       = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';

const WSTETH_LOWER = WSTETH_ADDRESS.toLowerCase();
const WBTC_LOWER   = WBTC_ADDRESS.toLowerCase();

/**
 * Live mainnet RPC for FxSdk deposit/withdraw quote calls.
 * fxSAVE epoch state is read from mainnet to avoid stale-epoch errors on forks.
 */
const MAINNET_RPC_URL =
  process.env.MAINNET_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';

/**
 * Choose RPC URL for FxSdk leverage calls.
 * In FORK mode, use the fork RPC so calldata is built against fork state (prices, liquidity).
 * Mainnet mode falls back to MAINNET_RPC_URL for best quotes via Velora/Odos/FxRoute.
 * chainId is always 1 because f(x) contract addresses are identical to mainnet.
 */
function leverageSdkRpcUrl(params: QuoteParams): string {
  return params.routingMode === 'FORK' ? (params.rpcUrl || MAINNET_RPC_URL) : MAINNET_RPC_URL;
}

/** Token address → f(x) market type */
const TOKEN_TO_MARKET: Record<string, 'ETH' | 'BTC'> = {
  [WSTETH_LOWER]: 'ETH',
  [WBTC_LOWER]:   'BTC',
};

/**
 * Returns fork-safe route targets.
 * On Tenderly fork, Odos/Velora API calls fail (mainnet quotes don't work on fork state).
 * FxRoute is purely on-chain — works on any fork based on mainnet state.
 */
function forkSafeTargets(routingMode?: string): string[] | undefined {
  if (routingMode === 'FORK') {
    return [FX_ROUTE, FX_ROUTE_V3];
  }
  return undefined; // MAINNET: let SDK pick best route (Velora/Odos/FxRoute)
}

// ─── FxProtocolAdapter ────────────────────────────────────────────────────────

export class FxProtocolAdapter implements DefiProtocolAdapter {
  readonly id = 'fx-protocol';
  readonly name = 'f(x) Protocol';
  readonly description =
    'f(x) Protocol — fxSAVE yield vault + leveraged long/short positions on wstETH and WBTC';
  readonly supportedChains = [1];
  readonly supportedSkills: DefiSkillType[] = [
    'DEPOSIT', 'WITHDRAW',
    'LEVERAGE_LONG', 'LEVERAGE_SHORT', 'LEVERAGE_CLOSE',
  ];
  readonly skillSource = 'https://github.com/AladdinDAO/fx-sdk-skill';

  /** Lazily discovered fxSAVE contract address (from first successful SDK call) */
  private fxSaveAddress: string | null = null;

  supportsToken(token: string, skill: DefiSkillType): boolean {
    const key = token.toLowerCase();
    if (skill === 'DEPOSIT') {
      return key === USDC_ADDRESS_LOWER;
    }
    if (skill === 'WITHDRAW') {
      if (key === USDC_ADDRESS_LOWER) return true;
      if (this.fxSaveAddress && key === this.fxSaveAddress.toLowerCase()) return true;
      return false;
    }
    if (skill === 'LEVERAGE_LONG') {
      return key in TOKEN_TO_MARKET;
    }
    if (skill === 'LEVERAGE_SHORT') {
      // SHORT collateral is fxUSD. Also accept wstETH/WBTC as market indicators.
      return key === FXUSD_ADDRESS.toLowerCase() || key in TOKEN_TO_MARKET;
    }
    if (skill === 'LEVERAGE_CLOSE') {
      return key in TOKEN_TO_MARKET;
    }
    return false;
  }

  async quote(params: QuoteParams): Promise<DefiSkillQuote | null> {
    if (params.skill === 'DEPOSIT')        return this._quoteDeposit(params);
    if (params.skill === 'WITHDRAW')       return this._quoteWithdraw(params);
    if (params.skill === 'LEVERAGE_LONG')  return this._quoteLeverageLong(params);
    if (params.skill === 'LEVERAGE_SHORT') return this._quoteLeverageShort(params);
    if (params.skill === 'LEVERAGE_CLOSE') return this._quoteLeverageClose(params);
    return null;
  }

  private async _quoteDeposit(params: QuoteParams): Promise<DefiSkillQuote | null> {
    const { tokenIn, amountIn, recipient, rpcUrl: forkRpcUrl } = params;
    try {
      if (tokenIn.toLowerCase() !== USDC_ADDRESS_LOWER) return null;

      // Prefer live mainnet RPC (avoids stale epoch on fork), fallback to fork RPC if mainnet fails.
      const rpcCandidates = [MAINNET_RPC_URL];
      if (forkRpcUrl && forkRpcUrl !== MAINNET_RPC_URL) rpcCandidates.push(forkRpcUrl);

      let result: Awaited<ReturnType<typeof FxSdk.prototype.depositFxSave>> | null = null;
      let lastErr = '';
      for (const rpc of rpcCandidates) {
        try {
          const sdk = new FxSdk({ rpcUrl: rpc, chainId: 1 });
          result = await sdk.depositFxSave({ userAddress: recipient, tokenIn: 'usdc', amount: amountIn, slippage: 0.5 });
          if (result?.txs?.length) break; // success
        } catch (err: any) {
          lastErr = err?.message ?? String(err);
          console.warn(`[FxProtocol] depositFxSave failed with rpc=${rpc.slice(0, 50)}: ${lastErr.slice(0, 200)}`);
        }
      }
      if (!result?.txs?.length) {
        console.error(`[FxProtocol] deposit quote: all RPCs failed. Last error: ${lastErr.slice(0, 300)}`);
        return null;
      }

      const txs = result.txs;
      if (!txs || txs.length === 0) return null;

      // Last tx is the main fxSAVE deposit; its .to is the fxSAVE contract
      const mainTx = txs[txs.length - 1];
      const fxSaveAddr = mainTx.to;
      this.fxSaveAddress = fxSaveAddr;

      // Find approve tx: selector 0x095ea7b3
      const approveTx = txs.find(
        t => typeof t.data === 'string' && t.data.startsWith('0x095ea7b3'),
      );

      // Build allCalls so simulation uses tenderly_simulateBundle (approve + deposit in order)
      const allCalls: CallData[] = [];
      if (approveTx) {
        allCalls.push({ to: approveTx.to, value: 0n, data: approveTx.data as string, description: 'Approve USDC' });
      }
      allCalls.push({ to: mainTx.to, value: mainTx.value ?? 0n, data: mainTx.data as string, description: 'Deposit to fxSAVE' });

      const apySdk = new FxSdk({ rpcUrl: MAINNET_RPC_URL, chainId: 1 });
      const apy = await this._fetchApy(apySdk);

      return {
        protocol: this.name,
        adapterId: this.id,
        skill: 'DEPOSIT',
        tokenIn: USDC_ADDRESS,
        tokenOut: fxSaveAddr,
        tokenOutSymbol: 'fxSAVE',
        amountIn,
        amountOut: amountIn,
        apy,
        contractTo: mainTx.to,
        calldata: mainTx.data as string,
        value: mainTx.value ?? 0n,
        allCalls,
        needsApproval: false,  // handled via allCalls
        approveTarget: '',
        route: `f(x) Protocol fxSAVE Deposit USDC${apy > 0 ? ` (${apy.toFixed(2)}% APY est.)` : ''}`,
        priceImpactBps: 0,
      };
    } catch (e) {
      console.warn('[FxProtocol] deposit quote error:', (e as Error).message?.slice(0, 120));
      return null;
    }
  }

  private async _quoteWithdraw(params: QuoteParams): Promise<DefiSkillQuote | null> {
    const { tokenIn, amountIn, recipient, rpcUrl: forkRpcUrl } = params;
    try {
      if (tokenIn.toLowerCase() !== USDC_ADDRESS_LOWER) return null;

      // Prefer live mainnet RPC; fallback to fork RPC if mainnet is unreachable.
      const rpcCandidates = [MAINNET_RPC_URL];
      if (forkRpcUrl && forkRpcUrl !== MAINNET_RPC_URL) rpcCandidates.push(forkRpcUrl);

      let result: Awaited<ReturnType<typeof FxSdk.prototype.withdrawFxSave>> | null = null;
      let lastErr = '';
      for (const rpc of rpcCandidates) {
        try {
          const sdk = new FxSdk({ rpcUrl: rpc, chainId: 1 });

          // Convert USDC amount to fxSAVE shares via config
          let sharesAmount: bigint;
          try {
            const config = await sdk.getFxSaveConfig();
            sharesAmount = config.totalAssetsWei > 0n
              ? (amountIn * config.totalSupplyWei) / config.totalAssetsWei
              : amountIn;
          } catch { sharesAmount = amountIn; }

          result = await sdk.withdrawFxSave({ userAddress: recipient, tokenOut: 'usdc', amount: sharesAmount, instant: true, slippage: 0.5 });
          if (result?.txs?.length) break;
        } catch (err: any) {
          lastErr = err?.message ?? String(err);
          console.warn(`[FxProtocol] withdrawFxSave failed with rpc=${rpc.slice(0, 50)}: ${lastErr.slice(0, 200)}`);
        }
      }
      if (!result?.txs?.length) {
        console.error(`[FxProtocol] withdraw quote: all RPCs failed. Last error: ${lastErr.slice(0, 300)}`);
        return null;
      }

      const txs = result.txs;

      const mainTx = txs[txs.length - 1];

      const approveTx = txs.find(
        t => typeof t.data === 'string' && t.data.startsWith('0x095ea7b3'),
      );

      const fxSaveAddr: string = approveTx
        ? approveTx.to
        : (this.fxSaveAddress ?? mainTx.to);

      this.fxSaveAddress = fxSaveAddr;

      // Build allCalls so simulation uses tenderly_simulateBundle (approve + withdraw in order)
      const allCalls: CallData[] = [];
      if (approveTx) {
        allCalls.push({ to: approveTx.to, value: 0n, data: approveTx.data as string, description: 'Approve fxSAVE' });
      }
      allCalls.push({ to: mainTx.to, value: mainTx.value ?? 0n, data: mainTx.data as string, description: 'Withdraw fxSAVE → USDC' });

      return {
        protocol: this.name,
        adapterId: this.id,
        skill: 'WITHDRAW',
        tokenIn: USDC_ADDRESS,
        tokenOut: USDC_ADDRESS,
        tokenOutSymbol: 'USDC',
        amountIn,
        amountOut: amountIn,
        apy: 0,
        contractTo: mainTx.to,
        calldata: mainTx.data as string,
        value: mainTx.value ?? 0n,
        allCalls,
        needsApproval: false,  // handled via allCalls
        approveTarget: '',
        receiptTokenIn: fxSaveAddr,
        route: 'f(x) Protocol fxSAVE Instant Withdraw → USDC',
        priceImpactBps: 0,
      };
    } catch (e) {
      console.warn('[FxProtocol] withdraw quote error:', (e as Error).message?.slice(0, 120));
      return null;
    }
  }

  private async _quoteLeverageLong(params: QuoteParams): Promise<DefiSkillQuote | null> {
    const { tokenIn, amountIn, recipient, routingMode, leverageMultiplier = 2, positionId = 0 } = params;
    try {
      const key = tokenIn.toLowerCase();
      const market = TOKEN_TO_MARKET[key];
      if (!market) return null;

      const sdk = new FxSdk({ rpcUrl: leverageSdkRpcUrl(params), chainId: 1 });
      const targets = forkSafeTargets(routingMode);

      // slippage: 5% — fork price may diverge from SDK quote time, FxRoute has tight price checks
      const result = await sdk.increasePosition({
        market,
        type: 'long',
        positionId,
        leverage: leverageMultiplier,
        inputTokenAddress: tokenIn.toLowerCase() as any,
        amount: amountIn,
        slippage: 5,
        userAddress: recipient,
        ...(targets ? { targets: targets as any } : {}),
      });

      // Pick first available route (SDK sorted by best price)
      const route = result.routes[0];
      if (!route || route.txs.length === 0) return null;

      const tokenSymbol = key === WSTETH_LOWER ? 'wstETH' : 'WBTC';
      const allCalls: CallData[] = route.txs.map((tx, idx) => ({
        to: tx.to,
        value: tx.value ?? 0n,
        data: tx.data as string,
        description: idx === 0 && route.txs.length > 1
          ? `Approve ${tokenSymbol}`
          : `Open ${leverageMultiplier}x Long ${tokenSymbol} (${market})`,
      }));

      return {
        protocol: this.name,
        adapterId: this.id,
        skill: 'LEVERAGE_LONG',
        tokenIn,
        tokenOut: tokenIn, // collateral stays in position
        tokenOutSymbol: tokenSymbol,
        amountIn,
        amountOut: amountIn,
        apy: 0,
        contractTo: allCalls[allCalls.length - 1].to,
        calldata: allCalls[allCalls.length - 1].data,
        value: allCalls[allCalls.length - 1].value,
        needsApproval: false, // handled in allCalls
        approveTarget: '',
        allCalls,
        leverageInfo: {
          market,
          positionType: 'long',
          leverage: leverageMultiplier,
          executionPrice: route.executionPrice,
          routeType: route.routeType,
        },
        route: `f(x) ${leverageMultiplier}x Long ${tokenSymbol} (${market} market, ${route.routeType})`,
        priceImpactBps: 0,
      };
    } catch (e) {
      console.warn('[FxProtocol] leverage long quote error:', (e as Error).message?.slice(0, 120));
      return null;
    }
  }

  private async _quoteLeverageShort(params: QuoteParams): Promise<DefiSkillQuote | null> {
    const { tokenIn, amountIn, recipient, routingMode, leverageMultiplier = 2, positionId = 0 } = params;
    try {
      const key = tokenIn.toLowerCase();

      // For SHORT positions, fxUSD is the actual collateral.
      // tokenIn may be:
      //   - fxUSD address → user holds fxUSD; market from params.market
      //   - WBTC / wstETH → used as market indicator; pass fxUSD to SDK (user must have fxUSD)
      let market: 'ETH' | 'BTC';
      if (key === FXUSD_ADDRESS.toLowerCase()) {
        const m = (params.market?.toUpperCase() ?? '') as 'ETH' | 'BTC';
        if (m !== 'ETH' && m !== 'BTC') return null;
        market = m;
      } else if (key in TOKEN_TO_MARKET) {
        market = TOKEN_TO_MARKET[key]!;
      } else {
        return null;
      }

      const sdk = new FxSdk({ rpcUrl: leverageSdkRpcUrl(params), chainId: 1 });
      const targets = forkSafeTargets(routingMode);

      // Always use fxUSD as inputTokenAddress — f(x) short collateral is fxUSD
      // slippage: 5% — fork price may diverge from SDK quote time, FxRoute 2 has tight price checks
      const result = await sdk.increasePosition({
        market,
        type: 'short',
        positionId,
        leverage: leverageMultiplier,
        inputTokenAddress: FXUSD_ADDRESS.toLowerCase() as any,
        amount: amountIn,
        slippage: 5,
        userAddress: recipient,
        ...(targets ? { targets: targets as any } : {}),
      });

      const route = result.routes[0];
      if (!route || route.txs.length === 0) return null;

      // Debug: log SDK tx breakdown for SHORT to diagnose approve issues
      console.log(`[FxProtocol] SHORT route.txs (${route.txs.length} txs, type=${route.routeType}):`,
        route.txs.map((tx, i) => ({
          idx: i,
          to: tx.to,
          selector: (tx.data as string)?.slice(0, 10),
          valueStr: tx.value?.toString() ?? '0',
        }))
      );

      const marketToken = market === 'ETH' ? 'wstETH' : 'WBTC';
      const mappedCalls: CallData[] = route.txs.map((tx, idx) => {
        let desc: string;
        if (idx === 0 && route.txs.length > 1) {
          const toAddr = tx.to?.toLowerCase() ?? '';
          const approveToken = toAddr === FXUSD_ADDRESS.toLowerCase() ? 'fxUSD'
            : toAddr === WBTC_LOWER ? 'WBTC'
            : toAddr === WSTETH_LOWER ? 'wstETH'
            : 'token';
          desc = `Approve ${approveToken}`;
        } else {
          desc = `Open ${leverageMultiplier}x Short ${marketToken} (${market})`;
        }
        return { to: tx.to, value: tx.value ?? 0n, data: tx.data as string, description: desc };
      });

      // If SDK returned only 1 tx (no approve), inject fxUSD approve ourselves.
      // Some SDK versions omit the approve when they detect an existing allowance via RPC;
      // on a fresh fork or after previous simulation the allowance may be insufficient.
      const hasApprove = mappedCalls.length > 1 ||
        (mappedCalls[0]?.data?.startsWith('0x095ea7b3') ?? false);
      const positionTx = mappedCalls[mappedCalls.length - 1];
      let allCalls: CallData[];
      if (!hasApprove) {
        const iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
        // Spender = position tx recipient (the router/position contract)
        const approveData = iface.encodeFunctionData('approve', [positionTx.to, ethers.MaxUint256]);
        allCalls = [
          { to: FXUSD_ADDRESS, value: 0n, data: approveData, description: 'Approve fxUSD' },
          { ...positionTx, description: `Open ${leverageMultiplier}x Short ${marketToken} (${market})` },
        ];
        console.log('[FxProtocol] SHORT: SDK omitted approve — injected fxUSD approve manually');
      } else {
        allCalls = mappedCalls;
      }

      return {
        protocol: this.name,
        adapterId: this.id,
        skill: 'LEVERAGE_SHORT',
        tokenIn,
        tokenOut: tokenIn,
        tokenOutSymbol: 'fxUSD',
        amountIn,
        amountOut: amountIn,
        apy: 0,
        contractTo: allCalls[allCalls.length - 1].to,
        calldata: allCalls[allCalls.length - 1].data,
        value: allCalls[allCalls.length - 1].value,
        needsApproval: false,
        approveTarget: '',
        allCalls,
        leverageInfo: {
          market,
          positionType: 'short',
          leverage: leverageMultiplier,
          executionPrice: route.executionPrice,
          routeType: route.routeType,
        },
        route: `f(x) ${leverageMultiplier}x Short ${marketToken} (${market} market, ${route.routeType})`,
        priceImpactBps: 0,
      };
    } catch (e) {
      console.warn('[FxProtocol] leverage short quote error:', (e as Error).message?.slice(0, 120));
      return null;
    }
  }

  private async _quoteLeverageClose(params: QuoteParams): Promise<DefiSkillQuote | null> {
    const { tokenIn, amountIn, recipient, routingMode, positionId = 0 } = params;
    try {
      const key = tokenIn.toLowerCase();
      const market = TOKEN_TO_MARKET[key];
      if (!market) return null;

      const sdk = new FxSdk({ rpcUrl: leverageSdkRpcUrl(params), chainId: 1 });
      const targets = forkSafeTargets(routingMode);

      // slippage: 5% — fork price divergence tolerance
      const result = await sdk.reducePosition({
        market,
        type: 'long', // reducePosition works for both long and short
        positionId,
        amount: amountIn,
        outputTokenAddress: tokenIn.toLowerCase() as any,
        slippage: 5,
        userAddress: recipient,
        isClosePosition: true,
        ...(targets ? { targets: targets as any } : {}),
      });

      const route = result.routes[0];
      if (!route || route.txs.length === 0) return null;

      const tokenSymbol = key === WSTETH_LOWER ? 'wstETH' : 'WBTC';
      const allCalls: CallData[] = route.txs.map((tx, idx) => ({
        to: tx.to,
        value: tx.value ?? 0n,
        data: tx.data as string,
        description: idx === 0 && route.txs.length > 1
          ? `Approve ${tokenSymbol}`
          : `Close Position ${tokenSymbol} (${market})`,
      }));

      return {
        protocol: this.name,
        adapterId: this.id,
        skill: 'LEVERAGE_CLOSE',
        tokenIn,
        tokenOut: tokenIn,
        tokenOutSymbol: tokenSymbol,
        amountIn,
        amountOut: amountIn,
        apy: 0,
        contractTo: allCalls[allCalls.length - 1].to,
        calldata: allCalls[allCalls.length - 1].data,
        value: allCalls[allCalls.length - 1].value,
        needsApproval: false,
        approveTarget: '',
        allCalls,
        leverageInfo: {
          market,
          positionType: 'close',
          leverage: 0,
          executionPrice: route.executionPrice,
          routeType: route.routeType,
        },
        route: `f(x) Close Position ${tokenSymbol} (${market} market, ${route.routeType})`,
        priceImpactBps: 0,
      };
    } catch (e) {
      console.warn('[FxProtocol] leverage close quote error:', (e as Error).message?.slice(0, 120));
      return null;
    }
  }

  buildCalls(quote: DefiSkillQuote): CallData[] {
    // Leverage quotes pre-pack all calls (approve + position tx)
    if (quote.allCalls && quote.allCalls.length > 0) return quote.allCalls;

    // fxSAVE deposit/withdraw
    const calls: CallData[] = [];
    if (quote.needsApproval) {
      const iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
      const approveToken =
        quote.skill === 'WITHDRAW' && quote.receiptTokenIn
          ? quote.receiptTokenIn
          : quote.tokenIn;
      calls.push({
        to: approveToken,
        value: 0n,
        data: iface.encodeFunctionData('approve', [quote.approveTarget, quote.amountIn]),
      });
    }
    calls.push({ to: quote.contractTo, value: quote.value, data: quote.calldata });
    return calls;
  }

  /** Estimate APY from fxSAVE config ratio; returns 0 on any failure.
   *  The sdk instance must already be connected to mainnet RPC. */
  private async _fetchApy(sdk: FxSdk): Promise<number> {
    try {
      const config = await sdk.getFxSaveConfig();
      if (config.totalAssetsWei > 0n && config.totalSupplyWei > 0n) {
        const expenseRatioPct = Number(config.expenseRatio) / 1e16;
        return Math.max(0, expenseRatioPct);
      }
      return 0;
    } catch {
      return 0;
    }
  }
}
