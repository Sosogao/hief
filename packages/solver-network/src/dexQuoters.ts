/**
 * dexQuoters.ts — Real DEX quote adapters for the HIEF solver auction
 *
 * Odos:       Free aggregator API, optimal multi-hop routing, returns full tx calldata
 * Uniswap V3: On-chain QuoterV2 + SwapRouter02 calldata, no external API needed
 *
 * Both run against a Tenderly mainnet fork: Odos quotes with chainId=1 (mainnet addresses
 * match the fork), Uniswap V3 quotes via eth_call on the fork RPC.
 */

import { ethers } from 'ethers';

// ─── Token addresses (Ethereum mainnet — same on mainnet fork) ────────────────
export const WETH    = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const ETH_ALIAS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const ODOS_ETH  = '0x0000000000000000000000000000000000000000';

// ─── Uniswap V3 contracts (Ethereum mainnet) ─────────────────────────────────
const QUOTER_V2     = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const SWAP_ROUTER02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

const QUOTER_ABI = [
  'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
const ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
];

export interface DexQuote {
  protocol:     string;
  amountOut:    bigint;       // raw output in output token's base units
  priceImpactBps: number;
  swapTo:       string;       // contract to call
  swapData:     string;       // calldata for the swap
  swapValue:    bigint;       // msg.value (0 for ERC20 input, ETH amount for ETH input)
  approveTarget: string;      // spender for tokenIn.approve()
  needsApproval: boolean;     // false when tokenIn is native ETH
  route:        string;       // human-readable
}

// ─── Uniswap V3 ───────────────────────────────────────────────────────────────

export async function quoteUniswapV3(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  recipient: string,
  slippageBps: number,
  rpcUrl: string,
): Promise<DexQuote | null> {
  try {
    const isEthIn  = tokenIn.toLowerCase()  === ETH_ALIAS.toLowerCase();
    const isEthOut = tokenOut.toLowerCase() === ETH_ALIAS.toLowerCase();
    const actualIn  = isEthIn  ? WETH : tokenIn;
    const actualOut = isEthOut ? WETH : tokenOut;

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const quoter   = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);

    // Try fee tiers 500 (0.05%), 3000 (0.3%), 10000 (1%) — pick best output
    let bestOut = 0n;
    let bestFee = 3000;
    for (const fee of [500, 3000, 10000]) {
      try {
        const [out] = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: actualIn, tokenOut: actualOut, amountIn, fee, sqrtPriceLimitX96: 0,
        });
        if (BigInt(out) > bestOut) { bestOut = BigInt(out); bestFee = fee; }
      } catch { /* pool may not exist at this fee tier */ }
    }
    if (bestOut === 0n) return null;

    const amountOutMin = bestOut * BigInt(10000 - slippageBps) / 10000n;
    const iface     = new ethers.Interface(ROUTER_ABI);
    const swapData  = iface.encodeFunctionData('exactInputSingle', [{
      tokenIn: actualIn,
      tokenOut: actualOut,
      fee: bestFee,
      recipient,                // output goes directly to Safe/EOA
      amountIn,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0,
    }]);

    return {
      protocol: 'Uniswap V3',
      amountOut: bestOut,
      priceImpactBps: Math.round(bestFee / 100),  // rough: fee ≈ impact
      swapTo: SWAP_ROUTER02,
      swapData,
      swapValue: isEthIn ? amountIn : 0n,
      approveTarget: SWAP_ROUTER02,
      needsApproval: !isEthIn,
      route: `UniV3 ${bestFee / 10000 * 100}% pool`,
    };
  } catch (e) {
    console.warn('[UniV3]', (e as Error).message?.slice(0, 120));
    return null;
  }
}

// ─── Odos Aggregator ──────────────────────────────────────────────────────────

export async function quoteOdos(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  userAddress: string,
  slippageBps: number,
): Promise<DexQuote | null> {
  try {
    const isEthIn  = tokenIn.toLowerCase()  === ETH_ALIAS.toLowerCase();
    const isEthOut = tokenOut.toLowerCase() === ETH_ALIAS.toLowerCase();
    const odosIn   = isEthIn  ? ODOS_ETH : tokenIn;
    const odosOut  = isEthOut ? ODOS_ETH : tokenOut;

    // Step 1: Quote
    const qRes = await fetch('https://api.odos.xyz/sor/quote/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chainId: 1,   // mainnet — fork mirrors mainnet contracts
        inputTokens:  [{ tokenAddress: odosIn,  amount: amountIn.toString() }],
        outputTokens: [{ tokenAddress: odosOut, proportion: 1 }],
        userAddr: userAddress,
        slippageLimitPercent: slippageBps / 100,
        compact: true,
        disableRFQs: false,
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!qRes.ok) return null;
    const q = await qRes.json() as any;
    if (!q.pathId || !q.outAmounts?.[0]) return null;

    const amountOut = BigInt(q.outAmounts[0]);
    if (amountOut === 0n) return null;

    // Step 2: Assemble calldata
    const aRes = await fetch('https://api.odos.xyz/sor/assemble', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAddr: userAddress, pathId: q.pathId, simulate: false }),
      signal: AbortSignal.timeout(7000),
    });
    if (!aRes.ok) return null;
    const a = await aRes.json() as any;
    if (!a.transaction?.data || !a.transaction?.to) return null;

    const tx = a.transaction;
    const priceImpact = Math.max(0, Math.round((q.priceImpact || 0) * 100));

    return {
      protocol: 'Odos',
      amountOut,
      priceImpactBps: priceImpact,
      swapTo: tx.to,
      swapData: tx.data,
      swapValue: isEthIn ? amountIn : 0n,
      approveTarget: tx.to,
      needsApproval: !isEthIn,
      route: `Odos → ${isEthOut ? 'ETH' : tokenOut.slice(0, 6)}`,
    };
  } catch (e) {
    console.warn('[Odos]', (e as Error).message?.slice(0, 120));
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Encode multiple calls for Safe's MultiSendCallOnly (DELEGATECALL safe to use) */
const MULTI_SEND_CALL_ONLY = '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D';

export function encodeMultiSend(calls: Array<{ to: string; value: bigint; data: string }>): {
  to: string; value: bigint; data: string; operation: 0 | 1;
} {
  const packed = calls.map(c => {
    const to     = c.to.toLowerCase().replace('0x', '').padStart(40, '0');
    const value  = c.value.toString(16).padStart(64, '0');
    const rawData = c.data.startsWith('0x') ? c.data.slice(2) : c.data;
    const len    = (rawData.length / 2).toString(16).padStart(64, '0');
    return `00${to}${value}${len}${rawData}`;   // operation=0 (CALL) for each inner call
  }).join('');

  const iface = new ethers.Interface(['function multiSend(bytes transactions)']);
  const data  = iface.encodeFunctionData('multiSend', ['0x' + packed]);

  return { to: MULTI_SEND_CALL_ONLY, value: 0n, data, operation: 1 };  // DELEGATECALL to MultiSend
}

/** ERC-20 approve calldata */
const ERC20_APPROVE_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];
export function encodeApprove(spender: string, amount: bigint): string {
  return new ethers.Interface(ERC20_APPROVE_ABI).encodeFunctionData('approve', [spender, amount]);
}

/** Build the execution calls for approve (if needed) + swap */
export function buildSwapCalls(
  tokenIn: string,
  amountIn: bigint,
  quote: DexQuote,
): Array<{ to: string; value: bigint; data: string }> {
  const calls: Array<{ to: string; value: bigint; data: string }> = [];
  if (quote.needsApproval) {
    calls.push({ to: tokenIn, value: 0n, data: encodeApprove(quote.approveTarget, amountIn) });
  }
  calls.push({ to: quote.swapTo, value: quote.swapValue, data: quote.swapData });
  return calls;
}
