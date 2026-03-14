/**
 * f(x) Protocol fxSAVE Adapter
 *
 * Integrates f(x) Protocol's fxSAVE vault into HIEF via the @aladdindao/fx-sdk.
 * Upstream skill reference: https://github.com/AladdinDAO/fx-sdk-skill
 *
 * Supported skills:
 *   DEPOSIT  — deposit USDC into fxSAVE → receive fxSAVE shares
 *   WITHDRAW — instant redeem fxSAVE shares → USDC (fee applies)
 *
 * Contract addresses (Ethereum mainnet):
 *   USDC:   0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
 *   fxUSD:  0x085780639CC2cACd35E474e71f4d000e2405d8f6
 *   fxSAVE: discovered dynamically from SDK txs (txs[last].to)
 */

import { ethers } from 'ethers';
import { FxSdk } from '@aladdindao/fx-sdk';
import {
  type DefiProtocolAdapter,
  type DefiSkillType,
  type QuoteParams,
  type DefiSkillQuote,
  type CallData,
} from '../defiSkills';

// ─── Constants ────────────────────────────────────────────────────────────────

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_ADDRESS_LOWER = USDC_ADDRESS.toLowerCase();
const FXUSD_ADDRESS = '0x085780639CC2cACd35E474e71f4d000e2405d8f6';
const USDC_DECIMALS = 6;

// ─── FxProtocolAdapter ────────────────────────────────────────────────────────

export class FxProtocolAdapter implements DefiProtocolAdapter {
  readonly id = 'fx-protocol';
  readonly name = 'f(x) Protocol';
  readonly description =
    'f(x) Protocol fxSAVE — earn yield on USDC via the f(x) leveraged stablecoin protocol';
  readonly supportedChains = [1];
  readonly supportedSkills: DefiSkillType[] = ['DEPOSIT', 'WITHDRAW'];
  readonly skillSource = 'https://github.com/AladdinDAO/fx-sdk-skill';

  /**
   * Lazily discovered fxSAVE contract address.
   * Populated on the first successful deposit or withdraw SDK call.
   */
  private fxSaveAddress: string | null = null;

  supportsToken(token: string, skill: DefiSkillType): boolean {
    const key = token.toLowerCase();
    if (skill === 'DEPOSIT') {
      // Accept USDC as deposit token
      return key === USDC_ADDRESS_LOWER;
    }
    if (skill === 'WITHDRAW') {
      // Accept USDC (user states amount in USDC) or fxSAVE shares token
      if (key === USDC_ADDRESS_LOWER) return true;
      if (this.fxSaveAddress && key === this.fxSaveAddress.toLowerCase()) return true;
      return false;
    }
    return false;
  }

  async quote(params: QuoteParams): Promise<DefiSkillQuote | null> {
    if (params.skill === 'DEPOSIT') return this._quoteDeposit(params);
    if (params.skill === 'WITHDRAW') return this._quoteWithdraw(params);
    return null;
  }

  private async _quoteDeposit(params: QuoteParams): Promise<DefiSkillQuote | null> {
    const { tokenIn, amountIn, recipient, rpcUrl } = params;
    try {
      if (tokenIn.toLowerCase() !== USDC_ADDRESS_LOWER) return null;

      const sdk = new FxSdk({ rpcUrl, chainId: 1 });

      const result = await sdk.depositFxSave({
        userAddress: recipient,
        tokenIn: 'usdc',
        amount: amountIn,
        slippage: 0.5,
      });

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

      let needsApproval = false;
      let approveTarget = '';

      if (approveTx) {
        needsApproval = true;
        // Extract spender from approve calldata:
        // 0x (2) + selector 8 chars + 24 leading zeros + 40 addr = offset 34, length 40
        approveTarget = '0x' + approveTx.data.slice(34, 74);
      }

      const apy = await this._fetchApy(sdk);

      return {
        protocol: this.name,
        adapterId: this.id,
        skill: 'DEPOSIT',
        tokenIn: USDC_ADDRESS,
        tokenOut: fxSaveAddr,
        tokenOutSymbol: 'fxSAVE',
        amountIn,
        amountOut: amountIn, // shares ≈ USDC amount (1:1 approximation; actual ratio via config)
        apy,
        contractTo: mainTx.to,
        calldata: mainTx.data as string,
        value: mainTx.value ?? 0n,
        needsApproval,
        approveTarget,
        route: `f(x) Protocol fxSAVE Deposit USDC${apy > 0 ? ` (${apy.toFixed(2)}% APY est.)` : ''}`,
        priceImpactBps: 0,
      };
    } catch (e) {
      console.warn('[FxProtocol] deposit quote error:', (e as Error).message?.slice(0, 120));
      return null;
    }
  }

  private async _quoteWithdraw(params: QuoteParams): Promise<DefiSkillQuote | null> {
    const { tokenIn, amountIn, recipient, rpcUrl } = params;
    try {
      // tokenIn is the underlying USDC amount the user wants back
      if (tokenIn.toLowerCase() !== USDC_ADDRESS_LOWER) return null;

      const sdk = new FxSdk({ rpcUrl, chainId: 1 });

      // Convert USDC amount to fxSAVE shares via config
      // shares = amountIn * totalSupplyWei / totalAssetsWei
      let sharesAmount: bigint;
      try {
        const config = await sdk.getFxSaveConfig();
        if (config.totalAssetsWei > 0n) {
          sharesAmount = (amountIn * config.totalSupplyWei) / config.totalAssetsWei;
        } else {
          sharesAmount = amountIn;
        }
      } catch {
        sharesAmount = amountIn;
      }

      const result = await sdk.withdrawFxSave({
        userAddress: recipient,
        tokenOut: 'usdc',
        amount: sharesAmount,
        instant: true,
        slippage: 0.5,
      });

      const txs = result.txs;
      if (!txs || txs.length === 0) return null;

      // Last tx is the main withdraw tx
      const mainTx = txs[txs.length - 1];

      // Discover fxSAVE address from the approve tx (spender approved = fxSAVE vault or router)
      // For WITHDRAW: the approve tx approves spending of fxSAVE shares
      const approveTx = txs.find(
        t => typeof t.data === 'string' && t.data.startsWith('0x095ea7b3'),
      );

      // The approve tx's .to is the fxSAVE shares token (what gets burned)
      const fxSaveAddr: string = approveTx
        ? approveTx.to
        : (this.fxSaveAddress ?? mainTx.to);

      this.fxSaveAddress = fxSaveAddr;

      let needsApproval = false;
      let approveTarget = '';

      if (approveTx) {
        needsApproval = true;
        // Extract spender from approve calldata
        approveTarget = '0x' + approveTx.data.slice(34, 74);
      }

      return {
        protocol: this.name,
        adapterId: this.id,
        skill: 'WITHDRAW',
        tokenIn: USDC_ADDRESS,
        tokenOut: USDC_ADDRESS,
        tokenOutSymbol: 'USDC',
        amountIn,
        amountOut: amountIn, // approximate; actual output may differ by fee
        apy: 0,
        contractTo: mainTx.to,
        calldata: mainTx.data as string,
        value: mainTx.value ?? 0n,
        needsApproval,
        approveTarget,
        // receiptTokenIn = fxSAVE shares (the token burned during withdraw; needed for sim funding)
        receiptTokenIn: fxSaveAddr,
        route: 'f(x) Protocol fxSAVE Instant Withdraw → USDC',
        priceImpactBps: 0,
      };
    } catch (e) {
      console.warn('[FxProtocol] withdraw quote error:', (e as Error).message?.slice(0, 120));
      return null;
    }
  }

  buildCalls(quote: DefiSkillQuote): CallData[] {
    const calls: CallData[] = [];
    if (quote.needsApproval) {
      const iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
      // For DEPOSIT: approve USDC spending
      // For WITHDRAW: approve fxSAVE shares spending (receiptTokenIn)
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

  /** Estimate APY from fxSAVE config ratio; returns 0 on any failure */
  private async _fetchApy(sdk: FxSdk): Promise<number> {
    try {
      const config = await sdk.getFxSaveConfig();
      // APY is not directly available; return 0 as conservative estimate
      // In production, you'd track totalAssets growth over time
      if (config.totalAssetsWei > 0n && config.totalSupplyWei > 0n) {
        // expenseRatio is in 1e18 scale; approximate net APY from protocol fee
        const expenseRatioPct = Number(config.expenseRatio) / 1e16; // pct
        // Return a conservative placeholder — real APY requires historical data
        return Math.max(0, expenseRatioPct);
      }
      return 0;
    } catch {
      return 0;
    }
  }
}
