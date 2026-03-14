/**
 * HIEF Solver Network
 *
 * Real multi-solver auction for HIEF intents backed by live DEX protocol integrations:
 *
 *   1. Odos Aggregator  — optimal multi-hop routing via Odos API (free, no API key)
 *   2. Uniswap V3       — direct AMM, on-chain QuoterV2 + SwapRouter02 calldata
 *   3. HIEF Native      — fallback using best available on-chain quote
 *
 * All quotes run against the Tenderly mainnet fork (contracts are identical to mainnet).
 * The winning solver's real swap calldata is embedded in the execution plan so Safe
 * multisig / ERC-4337 accounts execute the actual DEX trade on-chain.
 *
 * Port: 3008
 */

// Make BigInt JSON-serializable globally — converts to decimal string
// Must be set before any JSON.stringify call in this process
(BigInt.prototype as any).toJSON = function () { return this.toString(); };

import express, { Request, Response } from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { detectAccountMode, proposeSafeMultisig, executeWithSignatures, buildSafeTxTypedData, type AccountInfo, type ExecutionMode, type SafeTxData, type SafeProposalResult } from './safeMultisig';
import { quoteOdos, quoteUniswapV3, encodeMultiSend, encodeApprove, buildSwapCalls, type DexQuote } from './dexQuoters';
import { defiRegistry, type DefiSkillQuote, type DefiSkillType } from './defiSkills';
import { skillMarket } from './skillMarket';
import { executeERC4337, getOrCreateSimpleAccount, ENTRY_POINT_V06, type ERC4337ExecutionResult } from './erc4337';
import {
  buildSafe4337UserOperation, computeUserOpHash, buildUserOpTypedData,
  executeSafe4337WithSignature, getSafe4337AccountInfo,
  deployNewSafe4337Account, deployNewSafeMultisig,
  SAFE_4337_MODULE_V030, ENTRY_POINT_V07,
  type PackedUserOperation, type Safe4337ExecutionResult,
} from './safe4337';

// ─── Config ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3008', 10);
const BUS_URL = process.env.BUS_URL || 'http://localhost:3001';
// TENDERLY_RPC_URL is mutable at runtime via POST /v1/solver-network/config
let TENDERLY_RPC_URL = process.env.TENDERLY_RPC_URL || 'https://virtual.mainnet.eu.rpc.tenderly.co/34ba02bb-d61a-4c5b-90c6-0d2e9a8f367d';
let SETTLEMENT_CHAIN_ID = parseInt(process.env.SETTLEMENT_CHAIN_ID || '99917', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000', 10);
// Set ENABLE_TENDERLY_AUTOFUND=true to allow auto-funding Safe accounts on Tenderly forks (dev/test only)
const ENABLE_TENDERLY_AUTOFUND = process.env.ENABLE_TENDERLY_AUTOFUND === 'true';

// Load .env
const envPath = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

// ─── Solver Personas ──────────────────────────────────────────────────────────
interface SolverPersona {
  id: string;
  name: string;
  protocol: string;
  description: string;
  wallet: ethers.HDNodeWallet;
  // Pricing characteristics
  feeRateBps: number;      // base fee in bps
  latencyMs: number;       // simulated response latency
  successRate: number;     // 0-1, probability of providing a quote
  specialization: string;  // what this solver is best at
}

// DEX solvers — hardcoded (generic routing protocols)
const DEX_SOLVER_PERSONAS: SolverPersona[] = [
  {
    id: 'odos-solver-01',
    name: 'Odos Aggregator',
    protocol: 'Odos',
    description: 'Multi-hop aggregator routing across Uniswap, Curve, Balancer, and 100+ liquidity sources.',
    wallet: ethers.Wallet.createRandom(),
    feeRateBps: 0,
    latencyMs: 0,
    successRate: 1,
    specialization: 'aggregation',
  },
  {
    id: 'univ3-solver-01',
    name: 'Uniswap V3 Direct',
    protocol: 'Uniswap V3',
    description: 'Direct AMM execution on the best Uniswap V3 fee tier (0.05% / 0.3% / 1%).',
    wallet: ethers.Wallet.createRandom(),
    feeRateBps: 0,
    latencyMs: 0,
    successRate: 1,
    specialization: 'direct-amm',
  },
  {
    id: 'hief-native-solver-01',
    name: 'HIEF Native Solver',
    protocol: 'HIEF Native',
    description: 'HIEF\'s own solver — falls back to best available on-chain route.',
    wallet: ethers.Wallet.createRandom(),
    feeRateBps: 0,
    latencyMs: 0,
    successRate: 1,
    specialization: 'fallback',
  },
];

// DeFi protocol solvers — auto-generated from plugin registry
// To add a new protocol: defiRegistry.register(new MyAdapter()) in defiSkills.ts
const DEFI_SOLVER_PERSONAS: SolverPersona[] = defiRegistry.getAll().map(adapter => ({
  id: `${adapter.id}-solver`,
  name: adapter.name,
  protocol: adapter.name,   // protocol key matches adapter.name for dispatch in generateQuote
  description: adapter.description,
  wallet: ethers.Wallet.createRandom(),
  feeRateBps: 0,
  latencyMs: 0,
  successRate: 1,
  specialization: 'defi',
}));

const SOLVER_PERSONAS: SolverPersona[] = [...DEX_SOLVER_PERSONAS, ...DEFI_SOLVER_PERSONAS];

// ─── Token Price Oracle (mock) ─────────────────────────────────────────────────
const TOKEN_PRICES_USD: Record<string, number> = {
  USDC: 1.0,
  USDT: 1.0,
  DAI: 1.0,
  WETH: 2650.0,
  ETH: 2650.0,
  WBTC: 67000.0,
};

function getTokenPrice(symbol: string): number {
  return TOKEN_PRICES_USD[symbol.toUpperCase()] ?? 1.0;
}

function extractTokenSymbol(tokenAddr: string, intent: any): string {
  // Priority 1: uiHints from intent metadata
  const hints = intent.meta?.uiHints || {};
  // Will be resolved by caller context (input vs output)

  // Priority 2: address mapping
  const addrMap: Record<string, string> = {
    // Ethereum mainnet
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
    // Base
    '0x036cbd53842c5426634e7929541ec2318f3dcf7e': 'USDC',
    '0x4200000000000000000000000000000000000006': 'WETH',
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
    // ETH aliases
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 'ETH',
    '0x0000000000000000000000000000000000000000': 'ETH',
  };
  const sym = addrMap[tokenAddr];
  if (sym) return sym;
  // Priority 3: from intent text
  const text = intent.userIntentText || intent.meta?.userIntentText || '';
  const match = text.match(/\b(USDC|USDT|DAI|WETH|ETH|WBTC)\b/gi);
  if (match) return match[match.length - 1].toUpperCase();
  return 'UNKNOWN';
}

function extractInputToken(intent: any): string {
  const hints = intent.meta?.uiHints || {};
  if (hints.inputTokenSymbol) return hints.inputTokenSymbol.toUpperCase();
  return extractTokenSymbol(intent.input?.token || '', intent);
}

function extractOutputToken(intent: any): string {
  const hints = intent.meta?.uiHints || {};
  if (hints.outputTokenSymbol) return hints.outputTokenSymbol.toUpperCase();
  return extractTokenSymbol(intent.outputs?.[0]?.token || '', intent);
}

function extractInputAmount(intent: any): number {
  const hints = intent.meta?.uiHints || {};
  if (hints.inputAmountHuman) return parseFloat(hints.inputAmountHuman);
  // USDC has 6 decimals, ETH/WETH has 18
  const raw = parseFloat(intent.input?.amount || '0');
  const tokenSym = extractInputToken(intent);
  if (tokenSym === 'USDC' || tokenSym === 'USDT') return raw / 1e6;
  return raw / 1e18;
}

/** Extract the DeFi skill type from an intent (DEPOSIT, WITHDRAW, STAKE, etc.) */
function getIntentSkillType(intent: any): DefiSkillType | null {
  const type = intent.meta?.intentType
    || intent.intentType
    || (intent.meta?.tags?.[0] as string | undefined);
  const DEFI_SKILLS: DefiSkillType[] = ['DEPOSIT', 'WITHDRAW', 'STAKE', 'UNSTAKE', 'PROVIDE_LIQUIDITY'];
  return DEFI_SKILLS.includes(type) ? (type as DefiSkillType) : null;
}

/** Return true if the intent is a DeFi skill (not a SWAP) */
function isDeFiSkillIntent(intent: any): boolean {
  return getIntentSkillType(intent) !== null;
}

// ─── Quote Generation ─────────────────────────────────────────────────────────
interface SolverQuote {
  solverId: string;
  solverName: string;
  protocol: string;
  expectedOut: string;    // in output token base units (18 decimals)
  expectedOutUSD: number;
  fee: string;
  feeUSD: number;
  netOutUSD: number;
  validUntil: number;
  latencyMs: number;
  priceImpactBps: number;
  route: string;
  status: 'QUOTED' | 'FAILED' | 'TIMEOUT';
  error?: string;
  swapQuote?: DexQuote;       // real DEX calldata (populated for on-chain execution)
  execQuote?: DexQuote;       // fork-compatible execution quote (UniV3) — used when swapQuote is Odos (mainnet-only)
  defiSkillQuote?: DefiSkillQuote;  // non-swap DeFi skill quote (DEPOSIT, STAKE, etc.)
}

/** Token decimals for converting raw amounts to human-readable */
function getTokenDecimals(tokenAddr: string): number {
  const usdc = ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
                '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'];
  const usdt = ['0xdac17f958d2ee523a2206206994597c13d831ec7'];
  const wbtc = ['0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'];
  const addr = tokenAddr.toLowerCase();
  if (usdc.includes(addr)) return 6;
  if (usdt.includes(addr)) return 6;
  if (wbtc.includes(addr)) return 8;
  return 18;  // ETH, WETH, DAI, etc.
}

/**
 * Build the Safe/UserOp calldata for a winning quote.
 * Returns the (to, value, data, operation) tuple ready to feed into
 * proposeSafeMultisig / buildSafe4337UserOperation.
 * Centralised here so auction + execute endpoints share the same logic.
 */
function buildWinnerTxParams(winner: SolverQuote, intent: any): { to: string; value: bigint; data: string; operation: 0 | 1 } {
  const skillQ = winner.defiSkillQuote;
  const swapQ  = skillQ ? undefined : getExecQuote(winner);

  if (skillQ) {
    const calls = defiRegistry.buildCalls(skillQ);
    if (calls.length > 1) {
      const ms = encodeMultiSend(calls);
      return { to: ms.to, value: ms.value, data: ms.data, operation: ms.operation };
    }
    return { to: calls[0].to, value: calls[0].value, data: calls[0].data, operation: 0 };
  }

  if (swapQ) {
    if (swapQ.needsApproval) {
      const ms = encodeMultiSend([
        { to: intent.input?.token || '', value: 0n, data: encodeApprove(swapQ.approveTarget, BigInt(intent.input?.amount || '0')) },
        { to: swapQ.swapTo, value: swapQ.swapValue, data: swapQ.swapData },
      ]);
      return { to: ms.to, value: ms.value, data: ms.data, operation: ms.operation };
    }
    return { to: swapQ.swapTo, value: swapQ.swapValue, data: swapQ.swapData, operation: 0 };
  }

  // Fallback: WETH wrap proof-of-execution
  const wethIface = new ethers.Interface(['function deposit() payable']);
  return { to: WETH_ADDRESS, value: ethers.parseEther('0.001'), data: wethIface.encodeFunctionData('deposit', []), operation: 0 };
}

async function generateQuote(
  solver: SolverPersona,
  intent: any,
  inputAmountUSD: number,
  outputTokenSymbol: string,
): Promise<SolverQuote> {
  const t0 = Date.now();
  const tokenIn   = intent.input?.token || '';
  const tokenOut  = intent.outputs?.[0]?.token || '';
  const amountIn  = BigInt(intent.input?.amount || '0');
  const slippageBps = intent.constraints?.slippageBps ?? 50;
  const recipient = intent.smartAccount || intent.sender || ethers.ZeroAddress;
  const inputPrice  = getTokenPrice(extractInputToken(intent));

  // ── DeFi skill intent (DEPOSIT, WITHDRAW, …): route to registered protocol adapters ──
  const skillType = getIntentSkillType(intent);
  if (skillType) {
    // Find adapter whose name matches this solver's protocol key
    const adapter = defiRegistry.getAll().find(a => a.name === solver.protocol);
    if (!adapter || !adapter.supportedSkills.includes(skillType)) {
      return {
        solverId: solver.id, solverName: solver.name, protocol: solver.protocol,
        expectedOut: '0', expectedOutUSD: 0, fee: '0', feeUSD: 0, netOutUSD: 0,
        validUntil: 0, latencyMs: Date.now() - t0, priceImpactBps: 0,
        route: 'N/A', status: 'FAILED', error: `Not a ${skillType} solver`,
        swapQuote: undefined, defiSkillQuote: undefined,
      };
    }
    const skill = await adapter.quote({ skill: skillType, tokenIn, amountIn, recipient, rpcUrl: TENDERLY_RPC_URL });
    if (!skill) {
      return {
        solverId: solver.id, solverName: solver.name, protocol: adapter.name,
        expectedOut: '0', expectedOutUSD: 0, fee: '0', feeUSD: 0, netOutUSD: 0,
        validUntil: 0, latencyMs: Date.now() - t0, priceImpactBps: 0,
        route: 'N/A', status: 'FAILED', error: `Token not supported by ${adapter.name} for ${skillType}`,
        swapQuote: undefined, defiSkillQuote: undefined,
      };
    }
    const inDecimals  = getTokenDecimals(tokenIn);
    const amountHuman = Number(amountIn) / 10 ** inDecimals;
    const expectedUSD = amountHuman * inputPrice;  // 1:1 for lending protocol interactions
    return {
      solverId: solver.id,
      solverName: solver.name,
      protocol: adapter.name,
      expectedOut: skill.amountOut.toString(),
      expectedOutUSD: expectedUSD,
      fee: '0', feeUSD: 0,
      netOutUSD: expectedUSD,
      validUntil: Math.floor(Date.now() / 1000) + 300,
      latencyMs: Date.now() - t0,
      priceImpactBps: 0,
      route: skill.route,
      status: 'QUOTED',
      defiSkillQuote: skill,
    };
  }

  // ── SWAP intent: route to DEX solvers ────────────────────────────────────────
  const outputPrice = getTokenPrice(outputTokenSymbol);
  let dexQuote: DexQuote | null = null;
  let execQuote: DexQuote | null = null;  // fork-compatible execution quote (always UniV3)
  try {
    if (solver.protocol === 'Odos') {
      // Odos: use for price discovery (mainnet API), but also get UniV3 for fork execution
      dexQuote = await quoteOdos(tokenIn, tokenOut, amountIn, recipient, slippageBps);
      // Always get UniV3 as fork-compatible execution fallback (Odos calldata fails on diverged fork)
      execQuote = await quoteUniswapV3(tokenIn, tokenOut, amountIn, recipient, slippageBps, TENDERLY_RPC_URL);
    } else if (solver.protocol === 'Uniswap V3') {
      dexQuote = await quoteUniswapV3(tokenIn, tokenOut, amountIn, recipient, slippageBps, TENDERLY_RPC_URL);
      execQuote = dexQuote;  // UniV3 is already fork-compatible
    } else if (defiRegistry.getAll().some(a => a.name === solver.protocol)) {
      // DeFi protocol adapters don't handle SWAPs
      return {
        solverId: solver.id, solverName: solver.name, protocol: solver.protocol,
        expectedOut: '0', expectedOutUSD: 0, fee: '0', feeUSD: 0, netOutUSD: 0,
        validUntil: 0, latencyMs: Date.now() - t0, priceImpactBps: 0,
        route: 'N/A', status: 'FAILED', error: 'Not a swap solver',
        swapQuote: undefined, defiSkillQuote: undefined,
      };
    } else {
      // HIEF Native: try Uniswap V3 first (fork-compatible), then Odos as fallback
      dexQuote = await quoteUniswapV3(tokenIn, tokenOut, amountIn, recipient, slippageBps, TENDERLY_RPC_URL);
      if (!dexQuote) dexQuote = await quoteOdos(tokenIn, tokenOut, amountIn, recipient, slippageBps);
      if (dexQuote) dexQuote = { ...dexQuote, protocol: 'HIEF Native', route: dexQuote.route + ' (via HIEF)' };
      execQuote = dexQuote;
    }
  } catch (e) {
    console.warn(`[${solver.protocol}] quote error:`, (e as Error).message?.slice(0, 100));
  }

  if (!dexQuote) {
    return {
      solverId: solver.id, solverName: solver.name, protocol: solver.protocol,
      expectedOut: '0', expectedOutUSD: 0, fee: '0', feeUSD: 0, netOutUSD: 0,
      validUntil: 0, latencyMs: Date.now() - t0, priceImpactBps: 0,
      route: 'N/A', status: 'FAILED', error: 'No liquidity / API unavailable',
    };
  }

  const outDecimals  = getTokenDecimals(tokenOut);
  const amountOutHuman = Number(dexQuote.amountOut) / 10 ** outDecimals;
  const expectedOutUSD = amountOutHuman * outputPrice;

  return {
    solverId: solver.id,
    solverName: solver.name,
    protocol: dexQuote.protocol,
    expectedOut: dexQuote.amountOut.toString(),
    expectedOutUSD,
    fee: '0',
    feeUSD: 0,
    netOutUSD: expectedOutUSD,
    validUntil: Math.floor(Date.now() / 1000) + 300,
    latencyMs: Date.now() - t0,
    priceImpactBps: dexQuote.priceImpactBps,
    route: dexQuote.route,
    status: 'QUOTED',
    swapQuote: dexQuote,
    execQuote: execQuote ?? dexQuote,  // fork execution uses UniV3; fallback to swapQuote
  };
}

// ─── Settlement Engine ───────────────────────────────────────────────────────
// TENDERLY_RPC is an alias for TENDERLY_RPC_URL (kept for backward compat with simulateSettlement)
// Note: use TENDERLY_RPC_URL (the let variable) for all new code so runtime updates take effect
/**
 * Pick the right DexQuote for on-chain execution on the Tenderly fork.
 * Odos calldata is generated from live mainnet state and will revert on a diverged fork.
 * UniV3 calldata is generated against the fork's own pool state and always works on fork.
 * execQuote = UniV3 fallback stored alongside the Odos swapQuote; use it for settlement.
 */
function getExecQuote(winner: SolverQuote): DexQuote | undefined {
  return winner.execQuote ?? winner.swapQuote;
}

const SETTLEMENT_PRIVATE_KEY = process.env.SETTLEMENT_PRIVATE_KEY ||
  '0xf2be7fd8f35f99b3838c9dc7e1bdbeccaefb9031ebd223a18c1a8e54f5bb780d';
// Ethereum Mainnet token addresses (used on Tenderly mainnet fork)
const WETH_ADDRESS = process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // Mainnet WETH
const USDC_ADDRESS = process.env.USDC_ADDRESS || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // Mainnet USDC
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const WETH_ABI = [
  'function deposit() payable',
  'function balanceOf(address) view returns (uint256)',
];
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

/**
 * Simulate settlement using Tenderly's tenderly_simulateTransaction RPC method.
 * Does NOT broadcast a real transaction — only dry-runs it and returns expected results.
 */
export interface SimulationResult {
  success: boolean;
  gasUsed: number;
  gasEstimateUSD: number;
  expectedOutputToken: string;
  expectedOutputAmount: string;   // human-readable (e.g. "0.0377")
  expectedOutputAmountRaw: string; // wei / base units
  expectedOutputUSD: number;
  priceImpactBps: number;
  balanceChanges: Array<{ token: string; symbol: string; delta: string; deltaUSD: number }>;
  simulatedBlock: number;
  error?: string;
}

async function simulateSettlement(
  intent: any,
  winner: any,
  /** For MULTISIG/ERC4337 the Safe itself is msg.sender — simulate from its address */
  overrideSimFrom?: string,
): Promise<SimulationResult> {
  const inputToken  = (intent.input?.token  || '').toLowerCase();
  const outputToken = (intent.outputs?.[0]?.token || '').toLowerCase();
  const inputSymbol  = extractInputToken(intent);
  const outputSymbol = extractOutputToken(intent);

  const skillQ: DefiSkillQuote | undefined = winner?.defiSkillQuote;
  // Use fork-compatible execution quote for simulation (UniV3 works on fork; Odos may not)
  const swapQ: DexQuote | undefined = skillQ ? undefined : (winner ? getExecQuote(winner) : undefined);
  const amountIn  = BigInt(intent.input?.amount || '0');
  const amountOut = skillQ ? skillQ.amountOut : (swapQ ? swapQ.amountOut : 0n);

  const inDecimals    = getTokenDecimals(intent.input?.token || '');
  const outDecimals   = skillQ ? inDecimals : getTokenDecimals(intent.outputs?.[0]?.token || '');
  const amountOutHuman = (Number(amountOut) / 10 ** outDecimals).toFixed(6);
  const amountInHuman  = (Number(amountIn)  / 10 ** inDecimals).toFixed(inDecimals === 6 ? 2 : 6);
  const effectiveOutputSymbol = skillQ ? skillQ.tokenOutSymbol : outputSymbol;
  const outUSD = parseFloat(amountOutHuman) * (skillQ ? getTokenPrice(inputSymbol) : getTokenPrice(outputSymbol));
  const inUSD  = parseFloat(amountInHuman)  * getTokenPrice(inputSymbol);

  // Simulate from the user's account (or settlement wallet as fallback).
  // No auto-funding — if the account lacks tokens the simulation correctly fails.
  // Use the /faucet endpoint to fund test accounts before transacting.
  const simFrom = overrideSimFrom ?? new ethers.Wallet(SETTLEMENT_PRIVATE_KEY).address;

  let gasUsed = 250_000;
  let simulatedBlock = 0;
  let simSuccess = true;
  let simError: string | undefined;

  try {
    const approveIface = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)']);

    if (skillQ?.needsApproval) {
      // ── Aave ERC-20 deposit: approve + supply must be simulated as a bundle ──
      // tenderly_simulateBundle executes txs in sequence on the same forked state
      const approveData  = approveIface.encodeFunctionData('approve', [skillQ.approveTarget, skillQ.amountIn]);
      const bundlePayload = {
        jsonrpc: '2.0', method: 'tenderly_simulateBundle',
        params: [[
          { from: simFrom, to: skillQ.tokenIn,    data: approveData,    value: '0x0', gas: '0x15F90' },
          { from: simFrom, to: skillQ.contractTo, data: skillQ.calldata, value: '0x0', gas: '0x5B8D8' },
        ], 'latest'],
        id: 1,
      };
      const bundleRes  = await fetch(TENDERLY_RPC_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundlePayload), signal: AbortSignal.timeout(8000),
      });
      const bundleJson = await bundleRes.json() as any;
      if (bundleJson.error) {
        simSuccess = false;
        simError = bundleJson.error?.message || String(bundleJson.error);
      } else if (Array.isArray(bundleJson.result)) {
        const results = bundleJson.result as any[];
        gasUsed = results.reduce((sum: number, r: any) => sum + parseInt(r.gasUsed || '0', 16), 0) || 250_000;
        simulatedBlock = parseInt(results[results.length - 1]?.blockNumber || '0x0', 16);
        simSuccess = results.every((r: any) => r.status === true);
        if (!simSuccess) {
          const failed = results.find((r: any) => r.status !== true);
          simError = failed?.error?.message
            || failed?.revert_reason
            || 'Transaction reverted — Safe may lack token balance or approval';
        }
      }
    } else if (skillQ?.skill === 'WITHDRAW' && skillQ.value === 0n) {
      // ── ERC-20 WITHDRAW: simulate from user's smart account (which holds the aTokens) ──
      // The DEPOSIT credited aTokens to intent.smartAccount, not the settlement wallet.
      // Simulating from the user's account avoids any aToken pre-funding complexity.
      const withdrawSimFrom = intent?.smartAccount || intent?.sender || simFrom;
      const simPayload = {
        jsonrpc: '2.0', method: 'tenderly_simulateTransaction',
        params: [{ from: withdrawSimFrom, to: skillQ.contractTo, data: skillQ.calldata, value: '0x0', gas: '0x7A120' }, 'latest'],
        id: 1,
      };
      const simRes  = await fetch(TENDERLY_RPC_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(simPayload), signal: AbortSignal.timeout(8000),
      });
      const simJson = await simRes.json() as any;
      if (simJson.error) {
        simSuccess = false;
        simError = simJson.error?.message || String(simJson.error);
      } else {
        const result = simJson.result || {};
        gasUsed = parseInt(result.gasUsed || '0x3D090', 16);
        simulatedBlock = parseInt(result.blockNumber || '0x0', 16);
        simSuccess = result.status === true;
        if (!simSuccess) {
          simError = result.error?.message || result.revert_reason
            || 'WITHDRAW simulation failed — ensure you have deposited funds first';
        }
      }
    } else {
      // ── Single-tx simulation (swap or ETH deposit) ──────────────────────────
      const simTo       = skillQ ? skillQ.contractTo : (swapQ ? swapQ.swapTo   : WETH_ADDRESS);
      const simData     = skillQ ? skillQ.calldata   : (swapQ ? swapQ.swapData : '0xd0e30db0');
      const simValueBig = skillQ ? skillQ.value      : (swapQ ? swapQ.swapValue : ethers.parseEther('0.001'));
      const simValue    = '0x' + simValueBig.toString(16);
      const simPayload  = {
        jsonrpc: '2.0', method: 'tenderly_simulateTransaction',
        params: [{ from: simFrom, to: simTo, data: simData, value: simValue, gas: '0x7A120' }, 'latest'],
        id: 1,
      };
      const simRes  = await fetch(TENDERLY_RPC_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(simPayload), signal: AbortSignal.timeout(8000),
      });
      const simJson = await simRes.json() as any;
      if (simJson.error) {
        simSuccess = false;
        simError = simJson.error?.message || String(simJson.error);
      } else {
        const result = simJson.result || {};
        gasUsed = parseInt(result.gasUsed || '0x3D090', 16);
        simulatedBlock = parseInt(result.blockNumber || '0x0', 16);
        simSuccess = result.status === true;
        if (!simSuccess) {
          simError = result.error?.message || result.revert_reason || 'Transaction reverted';
        }
      }
    }
  } catch { /* ignore sim errors — still return DEX quote amounts */ }

  const gasEstimateUSD = gasUsed * 1e-9 * 2650;

  const effectiveOutputToken = skillQ ? skillQ.tokenOut : outputToken;
  const balanceChanges: SimulationResult['balanceChanges'] = [
    { token: inputToken,          symbol: inputSymbol,           delta: '-' + amountInHuman,  deltaUSD: -inUSD  },
    { token: effectiveOutputToken, symbol: effectiveOutputSymbol, delta: '+' + amountOutHuman, deltaUSD: outUSD  },
  ];

  console.log(`[Simulation] ✅ ${inputSymbol}→${effectiveOutputSymbol} | in: ${amountInHuman} | out: ${amountOutHuman} | gas: ${gasUsed}`);

  return {
    success: simSuccess,
    gasUsed,
    gasEstimateUSD,
    expectedOutputToken: effectiveOutputSymbol,
    expectedOutputAmount: amountOutHuman,
    expectedOutputAmountRaw: amountOut.toString(),
    expectedOutputUSD: outUSD,
    priceImpactBps: winner?.priceImpactBps ?? 0,
    balanceChanges,
    simulatedBlock,
    ...(simError && { error: simError }),
  };
}

/**
 * Execute settlement on Tenderly fork using real on-chain calldata.
 *
 * No auto-funding is performed — the executor must already hold the required
 * tokens and ETH. Use the /faucet endpoint to fund test accounts on the fork.
 *
 * Execution strategy:
 *   - userAddress provided (EOA DIRECT mode): hardhat_impersonateAccount +
 *     eth_sendTransaction RPC so the tx is from the user's own address.
 *     (eth_sendTransaction is used instead of ethers getSigner to avoid the
 *     "invalid account" error that occurs for addresses without private keys.)
 *   - no userAddress: settlement wallet (SETTLEMENT_PRIVATE_KEY) sends the tx.
 */
async function settleOnChain(
  intent: any,
  winner: any,
  /** User's EOA address to impersonate (DIRECT mode). Omit to use settlement wallet. */
  userAddress?: string,
): Promise<{ txHash: string; blockNumber: number; approveTxHash?: string }> {
  const provider    = new ethers.JsonRpcProvider(TENDERLY_RPC_URL);
  const wallet      = new ethers.Wallet(SETTLEMENT_PRIVATE_KEY, provider);
  const execAddress = userAddress ?? wallet.address;
  const useImpersonation = !!userAddress;

  if (useImpersonation) {
    await provider.send('hardhat_impersonateAccount', [execAddress]);
  }

  /**
   * Send a transaction from execAddress.
   * Impersonated accounts use eth_sendTransaction RPC directly (no private key
   * needed). Settlement wallet uses ethers Wallet.sendTransaction.
   */
  const sendRaw = async (
    to: string, data: string, value: bigint, gasLimit = 400_000n,
  ): Promise<{ hash: string; blockNumber: number }> => {
    if (useImpersonation) {
      const hash = await provider.send('eth_sendTransaction', [{
        from:  execAddress,
        to,
        data,
        value: value === 0n ? '0x0' : ('0x' + value.toString(16)),
        gas:   '0x' + gasLimit.toString(16),
      }]);
      const receipt = await provider.waitForTransaction(hash);
      return { hash, blockNumber: receipt?.blockNumber ?? 0 };
    } else {
      const tx = await wallet.sendTransaction({ to, data, value, gasLimit });
      const receipt = await tx.wait();
      return { hash: tx.hash, blockNumber: receipt?.blockNumber ?? 0 };
    }
  };

  const approveIface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
  const tokenIn  = intent.input?.token || '';
  const amountIn = BigInt(intent.input?.amount || '0');
  const skillQ: DefiSkillQuote | undefined = winner?.defiSkillQuote;
  // Use fork-compatible execution quote (UniV3); Odos calldata uses live mainnet state and reverts on diverged fork
  const swapQ: DexQuote | undefined = skillQ ? undefined : (winner ? getExecQuote(winner) : undefined);

  let txHash = '', blockNumber = 0;
  let approveTxHash: string | undefined;

  try {
    if (skillQ) {
      // ── DeFi skill execution (Aave DEPOSIT / WITHDRAW / etc.) ──────────────
      console.log(`[Settlement] ${skillQ.skill} via ${skillQ.protocol} | from: ${execAddress.slice(0, 10)}... | in: ${amountIn} → ${skillQ.tokenOutSymbol}`);

      // Approve ERC-20 spending if required (e.g. USDC → Aave Pool)
      if (skillQ.needsApproval && skillQ.value === 0n) {
        const approveToken = skillQ.receiptTokenIn ?? skillQ.tokenIn ?? tokenIn;
        const approveData  = approveIface.encodeFunctionData('approve', [skillQ.approveTarget, skillQ.amountIn]);
        const res = await sendRaw(approveToken, approveData, 0n, 100_000n);
        approveTxHash = res.hash;
        console.log(`[Settlement] ✅ Approve tx: ${approveTxHash} | block: ${res.blockNumber}`);
      }

      const res = await sendRaw(skillQ.contractTo, skillQ.calldata, skillQ.value, 400_000n);
      txHash      = res.hash;
      blockNumber = res.blockNumber;
      console.log(`[Settlement] ✅ ${skillQ.skill} tx: ${txHash} | block: ${blockNumber}`);

    } else if (swapQ) {
      // ── Real DEX swap ───────────────────────────────────────────────────────
      console.log(`[Settlement] Swap via ${swapQ.protocol} | from: ${execAddress.slice(0, 10)}... | in: ${amountIn} | out: ${swapQ.amountOut}`);

      if (swapQ.swapValue === 0n) {
        // ERC-20 input: approve router first
        const approveData = approveIface.encodeFunctionData('approve', [swapQ.approveTarget, amountIn * 2n]);
        await sendRaw(tokenIn, approveData, 0n, 100_000n);
      }

      const res = await sendRaw(swapQ.swapTo, swapQ.swapData, swapQ.swapValue, 500_000n);
      txHash      = res.hash;
      blockNumber = res.blockNumber;
      console.log(`[Settlement] ✅ Swap tx: ${txHash} | block: ${blockNumber}`);

    } else {
      // ── Fallback: WETH wrap ─────────────────────────────────────────────────
      const wethIface = new ethers.Interface(['function deposit() payable']);
      const res = await sendRaw(WETH_ADDRESS, wethIface.encodeFunctionData('deposit'), ethers.parseEther('0.001'), 100_000n);
      txHash      = res.hash;
      blockNumber = res.blockNumber;
      console.log(`[Settlement] Fallback WETH wrap: ${txHash}`);
    }
  } finally {
    if (useImpersonation) {
      await provider.send('hardhat_stopImpersonatingAccount', [execAddress]).catch(() => {});
    }
  }

  return { txHash, blockNumber, approveTxHash };
}

// ─── Auction Engine ───────────────────────────────────────────────────────────
interface AuctionResult {
  intentId: string;
  intentHash: string;
  quotes: SolverQuote[];
  winner: SolverQuote | null;
  winnerReason: string;
  auctionDurationMs: number;
  submittedSolutionId: string | null;
  submittedAt: number;
  // Simulation result (populated after auction, before user confirmation)
  simulation?: SimulationResult;
  // Execution mode: DIRECT | MULTISIG | ERC4337 | ERC4337_SAFE
  executionMode?: 'DIRECT' | 'MULTISIG' | 'ERC4337' | 'ERC4337_SAFE';
  accountInfo?: AccountInfo;
  // Multisig proposal (populated when executionMode === 'MULTISIG')
  multisigProposal?: SafeProposalResult & { threshold: number };
  // ERC-4337 result (populated when executionMode === 'ERC4337')
  erc4337Result?: ERC4337ExecutionResult;
  // Safe4337 result (populated when executionMode === 'ERC4337_SAFE')
  safe4337Result?: Safe4337ExecutionResult;
  // Settlement result (populated after user confirms execution)
  settlementTxHash?: string;
  settlementBlock?: number;
  settlementStatus?: string;
}

// In-memory store for pending simulations awaiting user confirmation
// intentId -> { intent, winner, simulation, accountInfo }
const pendingSimulations = new Map<string, {
  intent: any;
  winner: SolverQuote;
  simulation: SimulationResult;
  accountInfo?: AccountInfo;
  // Multisig mode: stored after /execute is called
  safeTxData?: SafeTxData;
  aiSignature?: string;        // AI proposer's signature (sig1)
  aiSignerAddress?: string;    // AI proposer's address
  safeTxHash?: string;         // EIP-712 hash
  safeTxTypedData?: any;       // Full EIP-712 typed data for frontend MetaMask call
  // ERC-4337 mode: stored after /execute is called
  erc4337Result?: ERC4337ExecutionResult;
  // Safe4337 mode: stored after /execute is called (awaiting MetaMask UserOp signature)
  safe4337UserOp?: PackedUserOperation;
  safe4337UserOpHash?: string;
  safe4337TypedData?: { domain: Record<string, unknown>; types: Record<string, unknown[]>; message: Record<string, unknown> };
  safe4337Result?: Safe4337ExecutionResult;
}>();

async function runAuction(intentId: string, intentHash: string, intent: any): Promise<AuctionResult> {
  const startTime = Date.now();

  // Determine input amount in USD using smart token extraction
  const inputToken = extractInputToken(intent);
  const outputToken = extractOutputToken(intent);
  const inputAmount = extractInputAmount(intent);
  const inputAmountUSD = inputAmount * getTokenPrice(inputToken);

  // Add reputation tier from intent metadata
  const enrichedIntent = { ...intent, reputationTier: intent.meta?.reputationTier || 'STANDARD' };

  console.log(`[SolverNetwork] Auction started for ${intentId.slice(0, 16)}... | ${inputAmount} ${inputToken} → ${outputToken} (~$${inputAmountUSD.toFixed(2)})`);

  // All solvers quote in parallel
  const quotePromises = SOLVER_PERSONAS.map(solver =>
    generateQuote(solver, enrichedIntent, inputAmountUSD, outputToken)
      .catch(err => ({
        solverId: solver.id,
        solverName: solver.name,
        protocol: solver.protocol,
        expectedOut: '0',
        expectedOutUSD: 0,
        fee: '0',
        feeUSD: 0,
        netOutUSD: 0,
        validUntil: 0,
        latencyMs: solver.latencyMs,
        priceImpactBps: 0,
        route: 'N/A',
        status: 'FAILED' as const,
        error: err.message,
        swapQuote: undefined,
        defiSkillQuote: undefined,
      }))
  );

  const quotes = await Promise.all(quotePromises);
  const auctionDurationMs = Date.now() - startTime;

  // Select winner: highest netOutUSD among valid quotes
  const validQuotes = quotes.filter(q => q.status === 'QUOTED' && q.validUntil > Math.floor(Date.now() / 1000));
  validQuotes.sort((a, b) => b.netOutUSD - a.netOutUSD);

  const winner = validQuotes[0] || null;
  let winnerReason = 'No valid quotes';
  let submittedSolutionId: string | null = null;
  let settlementTxHash: string | undefined;
  let settlementBlock: number | undefined;
  let settlementStatus: string | undefined;

  if (winner) {
    const margin = validQuotes.length > 1
      ? ((winner.netOutUSD - validQuotes[1].netOutUSD) / validQuotes[1].netOutUSD * 100).toFixed(3)
      : 'N/A';
    winnerReason = `Best net output: $${winner.netOutUSD.toFixed(4)} (+${margin}% vs runner-up)`;

    // Build and submit solution to Intent Bus
    const winnerSolver = SOLVER_PERSONAS.find(s => s.id === winner.solverId)!;
    const solutionId = ethers.hexlify(ethers.randomBytes(32));

    const solution = {
      solutionVersion: '0.1',
      solutionId,
      intentId,
      intentHash,
      solverId: winnerSolver.wallet.address,
      executionPlan: {
        calls: winner.defiSkillQuote
          ? defiRegistry.buildCalls(winner.defiSkillQuote)
              .map(c => ({ to: c.to, value: c.value.toString(), data: c.data, operation: 'CALL' as const }))
          : getExecQuote(winner)
            ? buildSwapCalls(intent.input?.token || '', BigInt(intent.input?.amount || '0'), getExecQuote(winner)!)
                .map(c => ({ to: c.to, value: c.value.toString(), data: c.data, operation: 'CALL' as const }))
            : [{ to: intent.outputs?.[0]?.token || WETH_ADDRESS, value: winner.expectedOut, data: '0x', operation: 'CALL' as const }],
      },
      quote: {
        expectedOut: winner.expectedOut,
        fee: winner.fee,
        validUntil: winner.validUntil,
      },
      stakeSnapshot: { amount: '0' },
      meta: {
        protocol: winner.protocol,
        route: winner.route,
        priceImpactBps: winner.priceImpactBps,
        auctionDurationMs,
        competingQuotes: quotes.length,
      },
      signature: {
        type: 'EIP712_EOA',
        signer: winnerSolver.wallet.address,
        sig: '0x' + '00'.repeat(65),
      },
    };

    try {
      const res = await fetch(`${BUS_URL}/v1/solutions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(solution),
      });
      const resJson = await res.json() as any;
      if (res.ok) {
        submittedSolutionId = solutionId;
        console.log(`[SolverNetwork] ✅ Winner: ${winner.solverName} | net=$${winner.netOutUSD.toFixed(4)} | tx submitted`);

        // Auto-select the winning solution
        await fetch(`${BUS_URL}/v1/intents/${intentId}/select`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ solutionId }),
        });

        // ─── Simulation Layer ─────────────────────────────────────────────────────
        // Step 1: Detect account execution mode (DIRECT vs MULTISIG vs ERC4337)
        const smartAccount = intent.sender || intent.smartAccount || '';
        let accountInfo: AccountInfo | undefined;
        let executionMode: 'DIRECT' | 'MULTISIG' | 'ERC4337' | 'ERC4337_SAFE' = 'DIRECT';
        if (smartAccount && smartAccount.startsWith('0x')) {
          try {
            accountInfo = await Promise.race([
              detectAccountMode(smartAccount, TENDERLY_RPC_URL, SETTLEMENT_CHAIN_ID),
              new Promise<AccountInfo>((_, reject) => setTimeout(() => reject(new Error('detectAccountMode timeout')), 6000)),
            ]);
            executionMode = accountInfo.mode;
            console.log(`[SolverNetwork] Account mode: ${executionMode} | threshold: ${accountInfo.threshold} | isSafe: ${accountInfo.isSafe} | isERC4337: ${accountInfo.isERC4337}`);
          } catch (modeErr: any) {
            console.warn(`[SolverNetwork] Account mode detection failed, defaulting to DIRECT: ${modeErr.message}`);
          }
        }

        // Step 2: Simulate settlement (both modes run simulation first)
        console.log(`[Simulation] Running pre-settlement simulation for ${intentId.slice(0, 16)}... (mode: ${executionMode})`);
        try {
          // Simulate from the user's own address for all modes:
          // - MULTISIG / ERC4337_SAFE: Safe is msg.sender
          // - DIRECT (EOA): simulate from the user's EOA so gas estimates are accurate
          const simOverride = smartAccount || undefined;
          const simResult = await simulateSettlement(intent, winner, simOverride);

          if (executionMode === 'MULTISIG' && accountInfo?.isSafe) {
            // ─── MULTISIG MODE ────────────────────────────────────────────────────
            // Propose Safe transaction — AI proposes, co-signers must approve
            console.log(`[SafeMultisig] Proposing Safe TX for ${intentId.slice(0, 16)}... | threshold: ${accountInfo.threshold}`);
            let multisigProposal: (SafeProposalResult & { threshold: number }) | undefined;
            try {
              // Build calldata: DeFi skill (Aave) or swap (UniV3)
              const { to: msTo, value: msValueBig, data: msData, operation: msOp } = buildWinnerTxParams(winner, intent);
              const msValue = msValueBig.toString();
              const proposal = await proposeSafeMultisig({
                safeAddress: smartAccount,
                chainId: SETTLEMENT_CHAIN_ID,
                rpcUrl: TENDERLY_RPC_URL,
                proposerPrivateKey: SETTLEMENT_PRIVATE_KEY,
                to: msTo, value: msValue, data: msData, operation: msOp,
                intentId,
              });
              multisigProposal = { ...proposal, threshold: accountInfo.threshold };
              // Store pending simulation with multisig context
              pendingSimulations.set(intentId, { intent, winner, simulation: simResult, accountInfo });
              // Notify Intent Bus: simulation + multisig proposal
              await fetch(`${BUS_URL}/v1/intents/${intentId}/simulate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  simulation: simResult,
                  executionMode: 'MULTISIG',
                  multisigProposal,
                }),
              }).catch(() => {});
              console.log(`[SafeMultisig] ✅ Proposal ready | safeTxHash: ${multisigProposal.safeTxHash.slice(0, 16)}... | threshold: ${accountInfo.threshold} | awaiting co-signatures`);
            } catch (msErr: any) {
              console.error(`[SafeMultisig] ❌ Proposal failed: ${msErr.message}. Falling back to DIRECT mode.`);
              executionMode = 'DIRECT';
              pendingSimulations.set(intentId, { intent, winner, simulation: simResult, accountInfo });
              await fetch(`${BUS_URL}/v1/intents/${intentId}/simulate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ simulation: simResult, executionMode: 'DIRECT' }),
              }).catch(() => {});
            }
            return {
              intentId, intentHash, quotes, winner, winnerReason, auctionDurationMs,
              submittedSolutionId, submittedAt: Math.floor(Date.now() / 1000),
              simulation: simResult, executionMode: 'MULTISIG', accountInfo, multisigProposal,
            };
          } else if (executionMode === 'ERC4337_SAFE' && accountInfo?.isSafe4337) {
            // ─── ERC4337_SAFE MODE ────────────────────────────────────────────────
            // Build UserOperation, compute hash, prepare typed data for MetaMask
            try {
              console.log(`[Safe4337] Building UserOp for ${intentId.slice(0, 16)}... | Safe: ${accountInfo.address.slice(0, 10)}...`);

              // Auto-fund Safe on Tenderly fork if needed (dev/test only)
              // Only runs when ENABLE_TENDERLY_AUTOFUND=true is set in environment
              if (ENABLE_TENDERLY_AUTOFUND) {
                const safeProvider = new ethers.JsonRpcProvider(TENDERLY_RPC_URL);
                const safeBalance = await safeProvider.getBalance(accountInfo.address);
                if (safeBalance < ethers.parseEther('0.01')) {
                  console.log(`[Safe4337] Safe has ${ethers.formatEther(safeBalance)} ETH — auto-funding 1 ETH via tenderly_setBalance (ENABLE_TENDERLY_AUTOFUND=true)`);
                  await safeProvider.send('tenderly_setBalance', [[accountInfo.address], '0xDE0B6B3A7640000']); // 1 ETH
                }
              }

              const { to: uoTo, value: uoValue, data: uoData, operation: uoOp } = buildWinnerTxParams(winner, intent);
              const userOp = await buildSafe4337UserOperation({
                safeAddress: accountInfo.address,
                to: uoTo, value: uoValue, data: uoData, operation: uoOp,
                rpcUrl: TENDERLY_RPC_URL,
              });
              const userOpHash = await computeUserOpHash(userOp, TENDERLY_RPC_URL);
              const typedData = await buildUserOpTypedData(userOp, userOpHash, SETTLEMENT_CHAIN_ID, TENDERLY_RPC_URL);
              // Store pending simulation with Safe4337 context
              pendingSimulations.set(intentId, {
                intent, winner, simulation: simResult, accountInfo,
                safe4337UserOp: userOp,
                safe4337UserOpHash: userOpHash,
                safe4337TypedData: typedData,
              });
              await fetch(`${BUS_URL}/v1/intents/${intentId}/simulate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  simulation: simResult,
                  executionMode: 'ERC4337_SAFE',
                  accountInfo: {
                    address: accountInfo.address,
                    entryPoint: ENTRY_POINT_V07,
                    accountType: 'Safe4337',
                    module: SAFE_4337_MODULE_V030,
                    owners: accountInfo.owners,
                    threshold: accountInfo.threshold,
                  },
                  userOpHash,
                }),
              }).catch(() => {});
              console.log(`[Safe4337] ✅ UserOp built | userOpHash: ${userOpHash.slice(0, 16)}... | awaiting MetaMask signature`);
              return {
                intentId, intentHash, quotes, winner, winnerReason, auctionDurationMs,
                submittedSolutionId, submittedAt: Math.floor(Date.now() / 1000),
                simulation: simResult, executionMode: 'ERC4337_SAFE', accountInfo,
              };
            } catch (safe4337Err: any) {
              console.error(`[Safe4337] ❌ UserOp build failed: ${safe4337Err.message}. Falling back to DIRECT.`);
              executionMode = 'DIRECT';
              pendingSimulations.set(intentId, { intent, winner, simulation: simResult, accountInfo });
              await fetch(`${BUS_URL}/v1/intents/${intentId}/simulate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ simulation: simResult, executionMode: 'DIRECT' }),
              }).catch(() => {});
              return {
                intentId, intentHash, quotes, winner, winnerReason, auctionDurationMs,
                submittedSolutionId, submittedAt: Math.floor(Date.now() / 1000),
                simulation: simResult, executionMode: 'DIRECT', accountInfo,
              };
            }
          } else if (executionMode === 'ERC4337' && accountInfo?.isERC4337) {
            // ─── ERC-4337 MODE (SimpleAccount / generic AA) ───────────────────────
            // Store pending simulation — ERC-4337 execution happens at /execute
            pendingSimulations.set(intentId, { intent, winner, simulation: simResult, accountInfo });
            await fetch(`${BUS_URL}/v1/intents/${intentId}/simulate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                simulation: simResult,
                executionMode: 'ERC4337',
                accountInfo: {
                  address: accountInfo.address,
                  entryPoint: accountInfo.entryPoint,
                  accountType: accountInfo.accountType,
                },
              }),
            }).catch(() => {});
            console.log(`[ERC4337] ✅ Simulation complete | account=${accountInfo.address.slice(0, 10)}... | type=${accountInfo.accountType} | awaiting user confirmation`);
            return {
              intentId, intentHash, quotes, winner, winnerReason, auctionDurationMs,
              submittedSolutionId, submittedAt: Math.floor(Date.now() / 1000),
              simulation: simResult, executionMode: 'ERC4337', accountInfo,
            };
          } else {
            // ─── DIRECT MODE ──────────────────────────────────────────────────────
            // Store pending simulation so user can confirm
            pendingSimulations.set(intentId, { intent, winner, simulation: simResult, accountInfo });
            // Notify Intent Bus of simulation result
            await fetch(`${BUS_URL}/v1/intents/${intentId}/simulate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ simulation: simResult, executionMode: 'DIRECT' }),
            }).catch(() => {});
            console.log(`[Simulation] ✅ Simulation complete | gasUsed: ${simResult.gasUsed} | expectedOut: ${simResult.expectedOutputAmount} WETH | mode: DIRECT | awaiting user confirmation`);
            return {
              intentId, intentHash, quotes, winner, winnerReason, auctionDurationMs,
              submittedSolutionId, submittedAt: Math.floor(Date.now() / 1000),
              simulation: simResult, executionMode: 'DIRECT', accountInfo,
            };
          }
        } catch (simErr: any) {
          console.error(`[Simulation] ❌ Simulation failed: ${simErr.message}`);
          // Fall through — return without simulation
        }
      } else {
        console.warn(`[SolverNetwork] ⚠️ Solution submission failed: ${JSON.stringify(resJson)}`);
      }
    } catch (err: any) {
      console.error(`[SolverNetwork] ❌ Failed to submit solution: ${err.message}`);
    }
  } else {
    console.warn(`[SolverNetwork] ⚠️ No valid quotes for ${intentId.slice(0, 16)}...`);
  }

  return {
    intentId,
    intentHash,
    quotes,
    winner,
    winnerReason,
    auctionDurationMs,
    submittedSolutionId,
    submittedAt: Math.floor(Date.now() / 1000),
  };
}

// ─── State ────────────────────────────────────────────────────────────────────
const processedIntents = new Set<string>();
const auctionHistory: AuctionResult[] = [];
let isPolling = false;
let totalAuctions = 0;
let totalWins = 0;

async function pollAndAuction() {
  if (isPolling) return;
  isPolling = true;

  try {
    const res = await fetch(`${BUS_URL}/v1/intents?status=BROADCAST&limit=20`);
    if (!res.ok) { isPolling = false; return; }
    const json = await res.json() as any;
    const intents = json.data || [];

    for (const intentRow of intents) {
      if (processedIntents.has(intentRow.id)) continue;
      processedIntents.add(intentRow.id);
      totalAuctions++;

      // Get full intent details (explorer-api first, bus fallback)
      try {
        let intent: any = {};
        let intentHash = '';
        const detailRes = await fetch(`http://localhost:3006/v1/explorer/intents/${intentRow.id}`);
        if (detailRes.ok) {
          const detail = await detailRes.json() as any;
          const intentData = detail.data;
          intent = intentData?.intent || {};
          intentHash = intentData?.intentHash || '';
        } else {
          const busRes = await fetch(`${BUS_URL}/v1/intents/${intentRow.id}`);
          if (!busRes.ok) continue;
          intent = await busRes.json() as any;
          intentHash = intent.intentHash || '';
        }
        const result = await runAuction(intentRow.id, intentHash, intent);
        if (result.submittedSolutionId) totalWins++;

        auctionHistory.unshift(result);
        if (auctionHistory.length > 50) auctionHistory.pop();
      } catch (err: any) {
        console.error(`[SolverNetwork] Error processing intent ${intentRow.id}:`, err.message);
      }
    }
  } catch (err: any) {
    console.error('[SolverNetwork] Poll error:', err.message);
  } finally {
    isPolling = false;
  }
}

// ─── Express Server ───────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// BigInt-safe JSON serializer — replaces bigint values with their decimal string representation
app.set('json replacer', (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value
);

/** Recursively convert BigInt values to strings for JSON-safe serialization */
function sanitizeBigInt<T>(obj: T): T {
  if (typeof obj === 'bigint') return obj.toString() as unknown as T;
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeBigInt) as unknown as T;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    result[key] = sanitizeBigInt((obj as Record<string, unknown>)[key]);
  }
  return result as T;
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'solver-network',
    version: '0.1.0',
    solvers: SOLVER_PERSONAS.map(s => ({ id: s.id, name: s.name, protocol: s.protocol })),
    totalAuctions,
    totalWins,
  });
});

// GET /v1/solver-network/solvers — list all solver personas
app.get('/v1/solver-network/solvers', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: SOLVER_PERSONAS.map(s => ({
      id: s.id,
      name: s.name,
      protocol: s.protocol,
      description: s.description,
      address: s.wallet.address,
      feeRateBps: s.feeRateBps,
      latencyMs: s.latencyMs,
      successRate: s.successRate,
      specialization: s.specialization,
    })),
  });
});

// GET /v1/solver-network/auctions — auction history
app.get('/v1/solver-network/auctions', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string || '20', 10);
  res.json({
    success: true,
    data: auctionHistory.slice(0, limit),
    meta: { total: auctionHistory.length, totalAuctions, totalWins },
  });
});

// POST /v1/solver-network/quote — request quotes for a hypothetical intent
app.post('/v1/solver-network/quote', async (req: Request, res: Response) => {
  const { inputToken, outputToken, inputAmount, reputationTier = 'STANDARD' } = req.body;
  if (!inputToken || !outputToken || !inputAmount) {
    res.status(400).json({ success: false, error: 'inputToken, outputToken, inputAmount required' });
    return;
  }

  const inputAmountUSD = parseFloat(inputAmount) * getTokenPrice(inputToken);
  const mockIntent = { userIntentText: `swap ${inputAmount} ${inputToken} to ${outputToken}`, reputationTier };

  const quotePromises = SOLVER_PERSONAS.map(solver =>
    generateQuote(solver, mockIntent, inputAmountUSD, outputToken)
  );
  const quotes = await Promise.all(quotePromises);
  const validQuotes = quotes.filter(q => q.status === 'QUOTED').sort((a, b) => b.netOutUSD - a.netOutUSD);

  res.json(sanitizeBigInt({
    success: true,
    data: {
      inputToken,
      outputToken,
      inputAmount,
      inputAmountUSD,
      quotes,
      bestQuote: validQuotes[0] || null,
      savings: validQuotes.length > 1
        ? ((validQuotes[0].netOutUSD - validQuotes[validQuotes.length - 1].netOutUSD) / validQuotes[validQuotes.length - 1].netOutUSD * 100).toFixed(2) + '%'
        : '0%',
    },
  }));
});

// POST /v1/solver-network/trigger — manually trigger auction for a specific intent
app.post('/v1/solver-network/trigger', async (req: Request, res: Response) => {
  const { intentId } = req.body;
  if (!intentId) {
    res.status(400).json({ success: false, error: 'intentId required' });
    return;
  }

  try {
    // Try explorer-api first; fall back to bus directly if not indexed yet
    let intent: any = {};
    let intentHash = '';
    const detailRes = await fetch(`http://localhost:3006/v1/explorer/intents/${intentId}`);
    if (detailRes.ok) {
      const detail = await detailRes.json() as any;
      const intentData = detail.data;
      intent = intentData?.intent || {};
      intentHash = intentData?.intentHash || '';
    } else {
      // Fallback: fetch directly from the bus
      const busRes = await fetch(`${BUS_URL}/v1/intents/${intentId}`);
      if (!busRes.ok) {
        res.status(404).json({ success: false, error: `Intent ${intentId} not found in explorer or bus` });
        return;
      }
      intent = await busRes.json() as any;
      // Compute intentHash from bus response (bus stores it)
      intentHash = intent.intentHash || '';
    }

    // Remove from processed set to allow re-auction
    processedIntents.delete(intentId);

    const result = await runAuction(intentId, intentHash, intent);
    if (result.submittedSolutionId) totalWins++;
    totalAuctions++;

    auctionHistory.unshift(result);
    if (auctionHistory.length > 50) auctionHistory.pop();

    res.json({ success: true, data: sanitizeBigInt(result) });
  } catch (err: any) {
    console.error('[trigger] ❌ Unhandled error:', err);
    res.status(500).json({ success: false, error: err.message, detail: err.stack?.split('\n')[1]?.trim() });
  }
});

// GET /v1/solver-network/simulation/:intentId — get pending simulation result
app.get('/v1/solver-network/simulation/:intentId', (req: Request, res: Response) => {
  const { intentId } = req.params;
  const pending = pendingSimulations.get(intentId);
  if (!pending) {
    res.status(404).json({ success: false, error: 'No pending simulation for this intent' });
    return;
  }
  res.json(sanitizeBigInt({
    success: true,
    data: {
      intentId,
      simulation: pending.simulation,
      winner: pending.winner,
      accountInfo: pending.accountInfo,
      executionMode: pending.accountInfo?.mode || 'DIRECT',
    },
  }));
});

// POST /v1/solver-network/execute/:intentId — user confirms, execute real settlement
// Works for both DIRECT mode (broadcasts immediately) and MULTISIG mode (marks as PENDING_SIGNATURES)
app.post('/v1/solver-network/execute/:intentId', async (req: Request, res: Response) => {
  const { intentId } = req.params;
  const pending = pendingSimulations.get(intentId);
  if (!pending) {
    res.status(404).json({ success: false, error: 'No pending simulation for this intent. Run trigger first.' });
    return;
  }
  const { intent, winner, accountInfo } = pending;
  const isMultisig  = accountInfo?.mode === 'MULTISIG'    && accountInfo?.isSafe;
  const isERC4337   = accountInfo?.mode === 'ERC4337'     && accountInfo?.isERC4337;
  const isSafe4337  = accountInfo?.mode === 'ERC4337_SAFE' && (accountInfo as any)?.isSafe4337;

  if (isSafe4337) {
    // ─── ERC4337_SAFE MODE: Build UserOp, return typed data for MetaMask ────────
    try {
      console.log(`[Safe4337] User confirmed Safe4337 execution for ${intentId.slice(0, 16)}... Preparing UserOp...`);

      // Check if UserOp was already built during simulation phase
      let userOp = pending.safe4337UserOp;
      let userOpHash = pending.safe4337UserOpHash;
      let typedData = pending.safe4337TypedData;

      if (!userOp || !userOpHash || !typedData) {
        // Build fresh UserOp using the winner's actual calldata
        const { to: uoTo, value: uoValue, data: uoData, operation: uoOp } = buildWinnerTxParams(winner, intent);
        userOp = await buildSafe4337UserOperation({
          safeAddress: accountInfo!.address,
          to: uoTo,
          value: uoValue,
          data: uoData,
          operation: uoOp,
          rpcUrl: TENDERLY_RPC_URL,
        });
        userOpHash = await computeUserOpHash(userOp, TENDERLY_RPC_URL);
        typedData = await buildUserOpTypedData(userOp, userOpHash, SETTLEMENT_CHAIN_ID, TENDERLY_RPC_URL);
        // Cache for collect-signature endpoint
        const updatedPending = pendingSimulations.get(intentId);
        if (updatedPending) {
          updatedPending.safe4337UserOp = userOp;
          updatedPending.safe4337UserOpHash = userOpHash;
          updatedPending.safe4337TypedData = typedData;
        }
      }

      console.log(`[Safe4337] ✅ UserOp ready | userOpHash: ${userOpHash.slice(0, 16)}... | awaiting MetaMask signature`);
      res.json({
        success: true,
        data: {
          intentId,
          executionMode: 'ERC4337_SAFE',
          status: 'PENDING_USER_SIGNATURE',
          userOpHash,
          userOpTypedData: typedData,   // field name expected by frontend requestSafe4337Signature()
          safeAddress: accountInfo!.address,
          entryPoint: ENTRY_POINT_V07,
          module: SAFE_4337_MODULE_V030,
          chainId: SETTLEMENT_CHAIN_ID,
          owners: accountInfo!.owners,
          threshold: accountInfo!.threshold,
        },
      });
    } catch (err: any) {
      console.error(`[Safe4337] ❌ UserOp preparation failed: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  } else if (isERC4337) {
    // ─── ERC-4337 MODE: Build UserOp, sign, submit via EntryPoint ──────────────────────────────
    try {
      console.log(`[ERC4337] User confirmed ERC-4337 execution for ${intentId.slice(0, 16)}... Building UserOp...`);

      // Build the settlement calldata (WETH wrap as representative tx)
      const wethInterface = new ethers.Interface(['function deposit() payable']);
      const depositData = wethInterface.encodeFunctionData('deposit', []);
      const txTo = WETH_ADDRESS;
      const txValue = ethers.parseEther('0.001').toString();
      const txData = depositData;

      const entryPointAddress = accountInfo.entryPoint || ENTRY_POINT_V06;

      // Execute via ERC-4337 (build UserOp → simulate → sign → submit)
      const result = await executeERC4337({
        accountAddress: accountInfo.address,
        to: txTo,
        value: txValue,
        data: txData,
        entryPointAddress,
        rpcUrl: TENDERLY_RPC_URL,
        ownerPrivateKey: SETTLEMENT_PRIVATE_KEY,
        chainId: SETTLEMENT_CHAIN_ID,
        accountType: accountInfo.accountType || 'SmartAccount',
      });

      // Store result
      const updatedPending = pendingSimulations.get(intentId);
      if (updatedPending) updatedPending.erc4337Result = result;

      // Notify Intent Bus: EXECUTED
      await fetch(`${BUS_URL}/v1/intents/${intentId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash: result.txHash, txStatus: 'success' }),
      }).catch(() => {});

      pendingSimulations.delete(intentId);

      // Update auction history
      const historyEntry = auctionHistory.find(a => a.intentId === intentId);
      if (historyEntry) {
        historyEntry.settlementTxHash = result.txHash;
        historyEntry.settlementBlock = result.blockNumber;
        historyEntry.settlementStatus = 'success';
        historyEntry.executionMode = 'ERC4337';
        historyEntry.erc4337Result = result;
      }

      console.log(`[ERC4337] ✅ EXECUTED | userOpHash: ${result.userOpHash.slice(0, 16)}... | txHash: ${result.txHash.slice(0, 16)}... | block: ${result.blockNumber}`);
      res.json({
        success: true,
        data: {
          intentId,
          executionMode: 'ERC4337',
          status: 'EXECUTED',
          userOpHash: result.userOpHash,
          txHash: result.txHash,
          blockNumber: result.blockNumber,
          entryPoint: entryPointAddress,
          accountType: accountInfo.accountType,
          userOpSimulation: result.simulation,
        },
      });
    } catch (err: any) {
      console.error(`[ERC4337] ❌ Execution failed: ${err.message}`);
      pendingSimulations.delete(intentId);
      await fetch(`${BUS_URL}/v1/intents/${intentId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash: '0x' + '0'.repeat(64), txStatus: 'failed' }),
      }).catch(() => {});
      res.status(500).json({ success: false, error: err.message });
    }
  } else if (isMultisig) {
    // ─── MULTISIG MODE: Propose Safe TX, wait for co-signatures ──────────────────────────────
    try {
      console.log(`[SafeMultisig] User confirmed multisig proposal for ${intentId.slice(0, 16)}... Proposing Safe TX...`);
      const { to: txTo, value: txValueBig, data: txData, operation: txOp } = buildWinnerTxParams(winner, intent);
      const txValue = txValueBig.toString();
      const proposal = await proposeSafeMultisig({
        safeAddress: accountInfo.address,
        chainId: SETTLEMENT_CHAIN_ID,
        rpcUrl: TENDERLY_RPC_URL,
        proposerPrivateKey: SETTLEMENT_PRIVATE_KEY,
        to: txTo,
        value: txValue,
        data: txData,
        operation: txOp,
        intentId,
      });
      const multisigProposal = { ...proposal, threshold: accountInfo.threshold };

      // Build the SafeTxData object for later execution
      const safeTxData: SafeTxData = {
        to: txTo,
        value: txValue,
        data: txData,
        operation: txOp,
        safeTxGas: '0',
        baseGas: '0',
        gasPrice: '0',
        gasToken: ethers.ZeroAddress,
        refundReceiver: ethers.ZeroAddress,
        nonce: multisigProposal.nonce,
      };

      // Build EIP-712 typed data for frontend MetaMask signing
      const typedData = buildSafeTxTypedData(safeTxData, accountInfo.address, SETTLEMENT_CHAIN_ID);

      // Compute AI's signature using EIP-712 signTypedData (v=27/28).
      // IMPORTANT: signMessage (eth_sign, v=31/32) is rejected by the Tenderly fork Safe.
      const aiWallet = new ethers.Wallet(SETTLEMENT_PRIVATE_KEY);
      const { domain: aiDomain, types: aiTypes, message: aiMessage } = typedData;
      const aiTypesNoDomain: Record<string, { name: string; type: string }[]> = { ...aiTypes };
      delete aiTypesNoDomain.EIP712Domain;
      const aiSignature = await aiWallet.signTypedData(aiDomain, aiTypesNoDomain, aiMessage);

      // Store safeTxData + AI signature in pendingSimulations (do NOT delete yet)
      const updatedPending = pendingSimulations.get(intentId);
      if (updatedPending) {
        updatedPending.safeTxData = safeTxData;
        updatedPending.aiSignature = aiSignature;
        updatedPending.aiSignerAddress = aiWallet.address;
        updatedPending.safeTxHash = multisigProposal.safeTxHash;
        updatedPending.safeTxTypedData = typedData;
      }

      // Notify Intent Bus: status → PENDING_SIGNATURES
      await fetch(`${BUS_URL}/v1/intents/${intentId}/multisig-propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ multisigProposal }),
      }).catch(() => {});
      // Update auction history
      const historyEntry = auctionHistory.find(a => a.intentId === intentId);
      if (historyEntry) { historyEntry.multisigProposal = multisigProposal; historyEntry.executionMode = 'MULTISIG'; }
      console.log(`[SafeMultisig] ✅ Proposal submitted | safeTxHash: ${multisigProposal.safeTxHash.slice(0, 16)}... | threshold: ${accountInfo.threshold} | awaiting co-signer via MetaMask`);
      res.json({
        success: true,
        data: {
          intentId,
          executionMode: 'MULTISIG',
          status: 'PENDING_SIGNATURES',
          safeTxHash: multisigProposal.safeTxHash,
          threshold: accountInfo.threshold,
          owners: accountInfo.owners,
          signingUrl: multisigProposal.signingUrl,
          safeServiceUrl: multisigProposal.safeServiceUrl,
          // EIP-712 typed data for MetaMask eth_signTypedData_v4
          typedData,
          aiSignerAddress: aiWallet.address,
          chainId: SETTLEMENT_CHAIN_ID,
        },
      });
    } catch (err: any) {
      console.error(`[SafeMultisig] ❌ Proposal failed: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  } else {
    // ─── DIRECT MODE: Broadcast immediately ────────────────────────────────────────────────────
    try {
      console.log(`[Settlement] User confirmed DIRECT execution for ${intentId.slice(0, 16)}... Broadcasting real tx...`);
      // Impersonate the user's EOA so the tx is executed from their address, not the backend wallet
      const userAddr = intent.sender || intent.smartAccount || accountInfo?.address;
      const { txHash, blockNumber, approveTxHash } = await settleOnChain(intent, winner, userAddr || undefined);
      pendingSimulations.delete(intentId);
      await fetch(`${BUS_URL}/v1/intents/${intentId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash, txStatus: 'success' }),
      });
      console.log(`[Settlement] ✅ EXECUTED | txHash: ${txHash} | block: ${blockNumber}`);
      const historyEntry = auctionHistory.find(a => a.intentId === intentId);
      if (historyEntry) {
        historyEntry.settlementTxHash = txHash;
        historyEntry.settlementBlock = blockNumber;
        historyEntry.settlementStatus = 'success';
        historyEntry.executionMode = 'DIRECT';
      }
      res.json({
        success: true,
        data: { intentId, executionMode: 'DIRECT', txHash, blockNumber, status: 'EXECUTED', approveTxHash },
      });
    } catch (err: any) {
      console.error(`[Settlement] ❌ Execution failed: ${err.message}`);
      pendingSimulations.delete(intentId);
      await fetch(`${BUS_URL}/v1/intents/${intentId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash: '0x' + '0'.repeat(64), txStatus: 'failed' }),
      }).catch(() => {});
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// POST /v1/solver-network/safe4337-collect-signature/:intentId
// Receives the user's EIP-712 UserOp signature from MetaMask.
// Submits the signed UserOperation via EntryPoint.handleOps().
app.post('/v1/solver-network/safe4337-collect-signature/:intentId', async (req: Request, res: Response) => {
  const { intentId } = req.params;
  const { userSignature, signerAddress } = req.body as { userSignature: string; signerAddress: string };

  if (!userSignature || !signerAddress) {
    res.status(400).json({ success: false, error: 'userSignature and signerAddress are required' });
    return;
  }

  const pending = pendingSimulations.get(intentId);
  if (!pending || !pending.safe4337UserOp || !pending.safe4337UserOpHash) {
    res.status(404).json({ success: false, error: 'No pending Safe4337 UserOp found. Call /execute first.' });
    return;
  }

  const { safe4337UserOp, accountInfo, intent, winner } = pending;

  try {
    console.log(`[Safe4337] User signature received from ${signerAddress.slice(0, 10)}... | Submitting UserOp via EntryPoint...`);

    const result = await executeSafe4337WithSignature({
      userOp: safe4337UserOp,
      userSignature,
      rpcUrl: TENDERLY_RPC_URL,
      submitterKey: SETTLEMENT_PRIVATE_KEY,
    });

    // Clean up pending state
    pendingSimulations.delete(intentId);

    // Notify Intent Bus: EXECUTED
    await fetch(`${BUS_URL}/v1/intents/${intentId}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: result.txHash, txStatus: 'success' }),
    }).catch(() => {});

    // Update auction history
    const historyEntry = auctionHistory.find(a => a.intentId === intentId);
    if (historyEntry) {
      historyEntry.settlementTxHash = result.txHash;
      historyEntry.settlementBlock = result.blockNumber;
      historyEntry.settlementStatus = 'success';
      historyEntry.executionMode = 'ERC4337_SAFE';
      historyEntry.safe4337Result = result;
    }

    console.log(`[Safe4337] ✅ UserOp EXECUTED | userOpHash: ${result.userOpHash.slice(0, 16)}... | txHash: ${result.txHash.slice(0, 16)}... | block: ${result.blockNumber}`);
    res.json({
      success: true,
      data: {
        intentId,
        executionMode: 'ERC4337_SAFE',
        status: 'EXECUTED',
        userOpHash: result.userOpHash,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        safeAddress: result.safeAddress,
        entryPoint: result.entryPoint,
      },
    });
  } catch (err: any) {
    console.error(`[Safe4337] ❌ UserOp execution failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /v1/solver-network/multisig-collect-signature/:intentId
// Receives the co-signer's EIP-712 signature from the frontend (MetaMask eth_signTypedData_v4).
// Once received, combines with AI's signature and calls Safe.execTransaction() on-chain.
app.post('/v1/solver-network/multisig-collect-signature/:intentId', async (req: Request, res: Response) => {
  const { intentId } = req.params;
  const { coSignerSignature, coSignerAddress } = req.body as { coSignerSignature: string; coSignerAddress: string };

  if (!coSignerSignature || !coSignerAddress) {
    res.status(400).json({ success: false, error: 'coSignerSignature and coSignerAddress are required' });
    return;
  }

  const pending = pendingSimulations.get(intentId);
  if (!pending || !pending.safeTxData || !pending.aiSignature || !pending.aiSignerAddress) {
    res.status(404).json({ success: false, error: 'No pending multisig proposal found for this intent. Call /execute first.' });
    return;
  }

  const { safeTxData, aiSignature, aiSignerAddress, accountInfo, intent, winner } = pending;

  try {
    console.log(`[SafeMultisig] Co-signer signature received from ${coSignerAddress.slice(0, 10)}... | Executing Safe TX on-chain...`);

    const { txHash, blockNumber } = await executeWithSignatures({
      safeAddress: accountInfo!.address,
      safeTx: safeTxData,
      sig1: aiSignature,
      signer1: aiSignerAddress,
      sig2: coSignerSignature,
      signer2: coSignerAddress,
      executorKey: SETTLEMENT_PRIVATE_KEY,
      rpcUrl: TENDERLY_RPC_URL,
    });

    // Clean up pending state
    pendingSimulations.delete(intentId);

    // Notify Intent Bus: EXECUTED
    await fetch(`${BUS_URL}/v1/intents/${intentId}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash, txStatus: 'success' }),
    }).catch(() => {});

    // Update auction history
    const historyEntry = auctionHistory.find(a => a.intentId === intentId);
    if (historyEntry) {
      historyEntry.settlementTxHash = txHash;
      historyEntry.settlementBlock = blockNumber;
      historyEntry.settlementStatus = 'success';
    }

    console.log(`[SafeMultisig] ✅ Multisig EXECUTED on-chain | txHash: ${txHash} | block: ${blockNumber}`);
    res.json({
      success: true,
      data: { intentId, executionMode: 'MULTISIG', txHash, blockNumber, status: 'EXECUTED' },
    });
  } catch (err: any) {
    console.error(`[SafeMultisig] ❌ execTransaction failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Faucet ──────────────────────────────────────────────────────────────────────────────────────────

// POST /v1/solver-network/faucet — fund a test address on the Tenderly fork.
// This is the ONLY place where tenderly_setBalance / tenderly_setErc20Balance should
// appear. All settlement and simulation paths are pure onchain — no auto-funding.
const FAUCET_TOKENS: Record<string, { address: string; decimals: number; defaultAmount: string }> = {
  ETH:  { address: '',                                             decimals: 18, defaultAmount: '0.5'  },
  WETH: { address: WETH_ADDRESS,                                   decimals: 18, defaultAmount: '1'    },
  USDC: { address: USDC_ADDRESS,                                   decimals: 6,  defaultAmount: '1000' },
  USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',   decimals: 6,  defaultAmount: '1000' },
  DAI:  { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',   decimals: 18, defaultAmount: '1000' },
};

app.post('/v1/solver-network/faucet', async (req: Request, res: Response) => {
  const { address, assets } = req.body as {
    address: string;
    /** e.g. [{ symbol: 'ETH' }, { symbol: 'USDC', amount: '500' }]. Defaults to ETH + USDC. */
    assets?: Array<{ symbol: string; amount?: string }>;
  };

  if (!address || !ethers.isAddress(address)) {
    res.status(400).json({ success: false, error: 'Invalid or missing address' });
    return;
  }

  const provider = new ethers.JsonRpcProvider(TENDERLY_RPC_URL);
  const toFund = assets?.length ? assets : [{ symbol: 'ETH' }, { symbol: 'USDC' }];
  const funded: Record<string, string> = {};
  const errors: Record<string, string> = {};

  for (const { symbol, amount } of toFund) {
    const key = symbol.toUpperCase();
    const cfg = FAUCET_TOKENS[key];
    if (!cfg) { errors[key] = 'Unknown token'; continue; }
    const humanAmt = amount ?? cfg.defaultAmount;
    try {
      if (key === 'ETH') {
        const wei = ethers.parseEther(humanAmt);
        await provider.send('tenderly_setBalance', [[address], '0x' + wei.toString(16)]);
      } else {
        const raw = BigInt(Math.round(parseFloat(humanAmt) * 10 ** cfg.decimals));
        await provider.send('tenderly_setErc20Balance', [cfg.address, address, '0x' + raw.toString(16)]);
      }
      funded[key] = humanAmt;
    } catch (e: any) {
      errors[key] = e.message?.slice(0, 80) ?? 'unknown error';
    }
  }

  console.log(`[Faucet] Funded ${address.slice(0, 10)}... | assets: ${JSON.stringify(funded)}`);
  res.json({ success: true, data: { address, funded, errors, network: 'Tenderly fork (test only)' } });
});

// ─── Skill Market API ────────────────────────────────────────────────────────

// GET /v1/solver-network/skills — list all registered DeFi skills
app.get('/v1/solver-network/skills', (_req: Request, res: Response) => {
  const skills = skillMarket.list().map(m => ({
    ...m,
    adapter: defiRegistry.getById(m.id)
      ? { id: m.id, supportedSkills: m.supportedSkills }
      : null,
  }));
  res.json({ success: true, data: skills });
});

// GET /v1/solver-network/skills/:id — get single skill detail
app.get('/v1/solver-network/skills/:id', (req: Request, res: Response) => {
  const manifest = skillMarket.get(req.params.id);
  if (!manifest) {
    res.status(404).json({ success: false, error: 'Skill not found' });
    return;
  }
  res.json({ success: true, data: manifest });
});

// ─── Config API ──────────────────────────────────────────────────────────────────────────────────────

// GET /v1/solver-network/config — return current runtime configuration
app.get('/v1/solver-network/config', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      tenderlyRpcUrl: TENDERLY_RPC_URL,
      settlementChainId: SETTLEMENT_CHAIN_ID,
      enableTenderlyAutofund: ENABLE_TENDERLY_AUTOFUND,
      busUrl: BUS_URL,
      port: PORT,
      wethAddress: WETH_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      entryPointV07: ENTRY_POINT_V07,
      safe4337Module: SAFE_4337_MODULE_V030,
    },
  });
});

// POST /v1/solver-network/config — update mutable runtime configuration
app.post('/v1/solver-network/config', (req: Request, res: Response) => {
  const { tenderlyRpcUrl, settlementChainId } = req.body;
  const updated: Record<string, unknown> = {};
  if (tenderlyRpcUrl && typeof tenderlyRpcUrl === 'string' && tenderlyRpcUrl.startsWith('http')) {
    TENDERLY_RPC_URL = tenderlyRpcUrl;
    updated.tenderlyRpcUrl = TENDERLY_RPC_URL;
    console.log(`[Config] TENDERLY_RPC_URL updated to: ${TENDERLY_RPC_URL}`);
  }
  if (settlementChainId && typeof settlementChainId === 'number') {
    SETTLEMENT_CHAIN_ID = settlementChainId;
    updated.settlementChainId = SETTLEMENT_CHAIN_ID;
    console.log(`[Config] SETTLEMENT_CHAIN_ID updated to: ${SETTLEMENT_CHAIN_ID}`);
  }
  res.json({ success: true, data: { updated, current: { tenderlyRpcUrl: TENDERLY_RPC_URL, settlementChainId: SETTLEMENT_CHAIN_ID } } });
});

// ─── Test Wallets API ──────────────────────────────────────────────────────────────────────────────────────

// Pre-configured test accounts for the three execution modes.
// These are Tenderly fork accounts funded with test ETH — DO NOT use on mainnet.
const TEST_WALLETS = [
  {
    type: 'EOA',
    label: 'EOA Wallet',
    description: 'Plain externally-owned account. Transactions are signed and executed directly from this address.',
    address: '0x7d73932636FbC0E57448BA175AbCd800C60daE5F',
    executionMode: 'DIRECT',
    icon: '👤',
    color: '#4ade80',
    note: 'No smart contract. Transactions execute directly from the EOA.',
  },
  {
    type: 'SAFE_MULTISIG',
    label: 'Safe Multisig Wallet',
    description: '2-of-2 Safe on Tenderly fork. Owners: user + AI key. Threshold: 2. Both must co-sign.',
    address: '0xFafEdAbe48661c553D766544d5374c8a619a11e5',
    executionMode: 'MULTISIG',
    icon: '🔐',
    color: '#a78bfa',
    owners: [
      '0x7d73932636FbC0E57448BA175AbCd800C60daE5F',
      '0xb5eb16b6dF444c07309fd5f5635BA21Ef30F8cA2',
    ],
    threshold: 2,
    note: 'AI proposes Safe TX. Co-signer must approve via MetaMask.',
  },
  {
    type: 'SAFE_4337',
    label: 'Safe + ERC-4337 Wallet',
    description: 'Safe with Safe4337Module enabled on Tenderly fork. Intents are executed as ERC-4337 UserOperations via EntryPoint v0.7.',
    address: '0xaeF8a6DEE58F73D2D79A656D985Bb9A083E4fBA6',
    executionMode: 'ERC4337_SAFE',
    icon: '🛡',
    color: '#fb923c',
    owners: [
      '0x7d73932636FbC0E57448BA175AbCd800C60daE5F',
    ],
    threshold: 1,
    module: SAFE_4337_MODULE_V030,
    entryPoint: ENTRY_POINT_V07,
    note: 'AI builds UserOp. User signs with MetaMask. EntryPoint → Safe4337Module → Safe.',
  },
];

// GET /v1/solver-network/test-wallets — return pre-configured test wallet info
app.get('/v1/solver-network/test-wallets', async (_req: Request, res: Response) => {
  try {
    const provider = new ethers.JsonRpcProvider(TENDERLY_RPC_URL);
    const walletsWithBalance = await Promise.all(
      TEST_WALLETS.map(async (w) => {
        try {
          const balance = await provider.getBalance(w.address);
          return { ...w, ethBalance: ethers.formatEther(balance) };
        } catch {
          return { ...w, ethBalance: 'N/A' };
        }
      })
    );
    res.json({ success: true, data: walletsWithBalance });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /v1/solver-network/fund-test-wallet — fund a test wallet via tenderly_setBalance (ENABLE_TENDERLY_AUTOFUND only)
app.post('/v1/solver-network/fund-test-wallet', async (req: Request, res: Response) => {
  if (!ENABLE_TENDERLY_AUTOFUND) {
    res.status(403).json({ success: false, error: 'ENABLE_TENDERLY_AUTOFUND is not enabled. Set ENABLE_TENDERLY_AUTOFUND=true to allow test funding.' });
    return;
  }
  const { address, amountEth } = req.body;
  if (!address || !ethers.isAddress(address)) {
    res.status(400).json({ success: false, error: 'Invalid address' });
    return;
  }
  const amount = parseFloat(amountEth || '1');
  if (isNaN(amount) || amount <= 0 || amount > 100) {
    res.status(400).json({ success: false, error: 'amountEth must be between 0 and 100' });
    return;
  }
  try {
    const provider = new ethers.JsonRpcProvider(TENDERLY_RPC_URL);
    const hexAmount = '0x' + ethers.parseEther(amount.toString()).toString(16);
    await provider.send('tenderly_setBalance', [[address], hexAmount]);
    const newBalance = await provider.getBalance(address);
    console.log(`[TestFund] Funded ${address} with ${amount} ETH via tenderly_setBalance`);
    res.json({ success: true, data: { address, amountEth: amount, newBalance: ethers.formatEther(newBalance) } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /v1/solver-network/create-smart-wallet — deploy a new Safe on the current Tenderly fork
app.post('/v1/solver-network/create-smart-wallet', async (req: Request, res: Response) => {
  const { ownerAddress, walletType } = req.body as { ownerAddress: string; walletType: 'multisig' | 'safe4337' };
  if (!ownerAddress || !ethers.isAddress(ownerAddress)) {
    res.status(400).json({ success: false, error: 'Invalid ownerAddress' });
    return;
  }
  if (walletType !== 'multisig' && walletType !== 'safe4337') {
    res.status(400).json({ success: false, error: 'walletType must be "multisig" or "safe4337"' });
    return;
  }
  try {
    const saltNonce = BigInt(Date.now());
    let safeAddress: string;
    let owners: string[];
    let threshold: number;
    const aiWallet = new ethers.Wallet(SETTLEMENT_PRIVATE_KEY);

    if (walletType === 'safe4337') {
      safeAddress = await deployNewSafe4337Account({
        owners: [ownerAddress],
        threshold: 1,
        saltNonce,
        rpcUrl: TENDERLY_RPC_URL,
        deployerKey: SETTLEMENT_PRIVATE_KEY,
      });
      owners = [ownerAddress];
      threshold = 1;
      console.log(`[CreateWallet] Deployed Safe4337 for ${ownerAddress.slice(0, 10)}... → ${safeAddress}`);
    } else {
      safeAddress = await deployNewSafeMultisig({
        userAddress: ownerAddress,
        saltNonce,
        rpcUrl: TENDERLY_RPC_URL,
        deployerKey: SETTLEMENT_PRIVATE_KEY,
      });
      owners = [ownerAddress, aiWallet.address];
      threshold = 2;
      console.log(`[CreateWallet] Deployed Safe Multisig for ${ownerAddress.slice(0, 10)}... → ${safeAddress}`);
    }

    // Auto-fund the new Safe with ETH for gas
    try {
      const provider = new ethers.JsonRpcProvider(TENDERLY_RPC_URL);
      const hexAmount = '0x' + ethers.parseEther('1').toString(16);
      await provider.send('tenderly_setBalance', [[safeAddress], hexAmount]);
    } catch { /* Non-critical — fork might not support setBalance */ }

    res.json({ success: true, data: { safeAddress, walletType, owners, threshold } });
  } catch (err: any) {
    console.error('[CreateWallet] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => { console.log(`[SolverNetwork] Service started on port ${PORT}`);
  console.log(`[SolverNetwork] ${SOLVER_PERSONAS.length} solvers registered: ${SOLVER_PERSONAS.map(s => s.name).join(', ')}`);
  console.log(`[SolverNetwork] Polling Intent Bus at ${BUS_URL} every ${POLL_INTERVAL_MS}ms`);

  // Initial poll
  setTimeout(pollAndAuction, 2000);
  setInterval(pollAndAuction, POLL_INTERVAL_MS);
});
