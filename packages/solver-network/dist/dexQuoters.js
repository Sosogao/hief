"use strict";
/**
 * dexQuoters.ts — Real DEX quote adapters for the HIEF solver auction
 *
 * Odos:       Free aggregator API, optimal multi-hop routing, returns full tx calldata
 * Uniswap V3: On-chain QuoterV2 + SwapRouter02 calldata, no external API needed
 *
 * Both run against a Tenderly mainnet fork: Odos quotes with chainId=1 (mainnet addresses
 * match the fork), Uniswap V3 quotes via eth_call on the fork RPC.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ODOS_ETH = exports.ETH_ALIAS = exports.WETH = void 0;
exports.quoteUniswapV3 = quoteUniswapV3;
exports.quoteOdos = quoteOdos;
exports.encodeMultiSend = encodeMultiSend;
exports.encodeApprove = encodeApprove;
exports.buildSwapCalls = buildSwapCalls;
const ethers_1 = require("ethers");
// ─── Token addresses (Ethereum mainnet — same on mainnet fork) ────────────────
exports.WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
exports.ETH_ALIAS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
exports.ODOS_ETH = '0x0000000000000000000000000000000000000000';
// ─── Uniswap V3 contracts (Ethereum mainnet) ─────────────────────────────────
const QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const SWAP_ROUTER02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const QUOTER_ABI = [
    'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
const ROUTER_ABI = [
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
];
// ─── Uniswap V3 ───────────────────────────────────────────────────────────────
async function quoteUniswapV3(tokenIn, tokenOut, amountIn, recipient, slippageBps, rpcUrl) {
    try {
        const isEthIn = tokenIn.toLowerCase() === exports.ETH_ALIAS.toLowerCase();
        const isEthOut = tokenOut.toLowerCase() === exports.ETH_ALIAS.toLowerCase();
        const actualIn = isEthIn ? exports.WETH : tokenIn;
        const actualOut = isEthOut ? exports.WETH : tokenOut;
        const provider = new ethers_1.ethers.JsonRpcProvider(rpcUrl);
        const quoter = new ethers_1.ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);
        // Try fee tiers 500 (0.05%), 3000 (0.3%), 10000 (1%) — pick best output
        let bestOut = 0n;
        let bestFee = 3000;
        for (const fee of [500, 3000, 10000]) {
            try {
                const [out] = await quoter.quoteExactInputSingle.staticCall({
                    tokenIn: actualIn, tokenOut: actualOut, amountIn, fee, sqrtPriceLimitX96: 0,
                });
                if (BigInt(out) > bestOut) {
                    bestOut = BigInt(out);
                    bestFee = fee;
                }
            }
            catch { /* pool may not exist at this fee tier */ }
        }
        if (bestOut === 0n)
            return null;
        const amountOutMin = bestOut * BigInt(10000 - slippageBps) / 10000n;
        const iface = new ethers_1.ethers.Interface(ROUTER_ABI);
        const swapData = iface.encodeFunctionData('exactInputSingle', [{
                tokenIn: actualIn,
                tokenOut: actualOut,
                fee: bestFee,
                recipient, // output goes directly to Safe/EOA
                amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0,
            }]);
        return {
            protocol: 'Uniswap V3',
            amountOut: bestOut,
            priceImpactBps: Math.round(bestFee / 100), // rough: fee ≈ impact
            swapTo: SWAP_ROUTER02,
            swapData,
            swapValue: isEthIn ? amountIn : 0n,
            approveTarget: SWAP_ROUTER02,
            needsApproval: !isEthIn,
            route: `UniV3 ${bestFee / 10000 * 100}% pool`,
        };
    }
    catch (e) {
        console.warn('[UniV3]', e.message?.slice(0, 120));
        return null;
    }
}
// ─── Odos Aggregator ──────────────────────────────────────────────────────────
async function quoteOdos(tokenIn, tokenOut, amountIn, userAddress, slippageBps) {
    try {
        const isEthIn = tokenIn.toLowerCase() === exports.ETH_ALIAS.toLowerCase();
        const isEthOut = tokenOut.toLowerCase() === exports.ETH_ALIAS.toLowerCase();
        const odosIn = isEthIn ? exports.ODOS_ETH : tokenIn;
        const odosOut = isEthOut ? exports.ODOS_ETH : tokenOut;
        // Step 1: Quote
        const qRes = await fetch('https://api.odos.xyz/sor/quote/v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chainId: 1, // mainnet — fork mirrors mainnet contracts
                inputTokens: [{ tokenAddress: odosIn, amount: amountIn.toString() }],
                outputTokens: [{ tokenAddress: odosOut, proportion: 1 }],
                userAddr: userAddress,
                slippageLimitPercent: slippageBps / 100,
                compact: true,
                disableRFQs: false,
            }),
            signal: AbortSignal.timeout(7000),
        });
        if (!qRes.ok)
            return null;
        const q = await qRes.json();
        if (!q.pathId || !q.outAmounts?.[0])
            return null;
        const amountOut = BigInt(q.outAmounts[0]);
        if (amountOut === 0n)
            return null;
        // Step 2: Assemble calldata
        const aRes = await fetch('https://api.odos.xyz/sor/assemble', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userAddr: userAddress, pathId: q.pathId, simulate: false }),
            signal: AbortSignal.timeout(7000),
        });
        if (!aRes.ok)
            return null;
        const a = await aRes.json();
        if (!a.transaction?.data || !a.transaction?.to)
            return null;
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
    }
    catch (e) {
        console.warn('[Odos]', e.message?.slice(0, 120));
        return null;
    }
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
/** Encode multiple calls for Safe's MultiSendCallOnly (DELEGATECALL safe to use) */
const MULTI_SEND_CALL_ONLY = '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D';
function encodeMultiSend(calls) {
    const packed = calls.map(c => {
        const to = c.to.toLowerCase().replace('0x', '').padStart(40, '0');
        const value = c.value.toString(16).padStart(64, '0');
        const rawData = c.data.startsWith('0x') ? c.data.slice(2) : c.data;
        const len = (rawData.length / 2).toString(16).padStart(64, '0');
        return `00${to}${value}${len}${rawData}`; // operation=0 (CALL) for each inner call
    }).join('');
    const iface = new ethers_1.ethers.Interface(['function multiSend(bytes transactions)']);
    const data = iface.encodeFunctionData('multiSend', ['0x' + packed]);
    return { to: MULTI_SEND_CALL_ONLY, value: 0n, data, operation: 1 }; // DELEGATECALL to MultiSend
}
/** ERC-20 approve calldata */
const ERC20_APPROVE_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];
function encodeApprove(spender, amount) {
    return new ethers_1.ethers.Interface(ERC20_APPROVE_ABI).encodeFunctionData('approve', [spender, amount]);
}
/** Build the execution calls for approve (if needed) + swap */
function buildSwapCalls(tokenIn, amountIn, quote) {
    const calls = [];
    if (quote.needsApproval) {
        calls.push({ to: tokenIn, value: 0n, data: encodeApprove(quote.approveTarget, amountIn) });
    }
    calls.push({ to: quote.swapTo, value: quote.swapValue, data: quote.swapData });
    return calls;
}
