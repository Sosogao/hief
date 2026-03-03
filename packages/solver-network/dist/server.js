"use strict";
/**
 * HIEF Solver Network
 *
 * Simulates a competitive multi-solver auction for HIEF intents.
 * Three solver personas compete to provide the best quote:
 *
 *   1. CoW Solver    — CoW Protocol style batch auction, best for stable pairs
 *   2. UniswapX Solver — UniswapX Dutch auction style, competitive on volatile pairs
 *   3. HIEF Native Solver — HIEF's own solver, optimizes for user reputation tier
 *
 * Flow:
 *   1. Poll Intent Bus for BROADCAST intents
 *   2. All 3 solvers quote in parallel (with realistic latency simulation)
 *   3. Best quote (highest expectedOut, lowest fee) wins
 *   4. Winner's solution is submitted to Intent Bus
 *   5. Bus auto-selects the best solution
 *
 * Port: 3008
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const ethers_1 = require("ethers");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const url_1 = require("url");
const __dirname = path.dirname((0, url_1.fileURLToPath)(import.meta.url));
// ─── Config ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3008', 10);
const BUS_URL = process.env.BUS_URL || 'http://localhost:3001';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000', 10);
// Load .env
const envPath = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match && !process.env[match[1]])
            process.env[match[1]] = match[2].trim();
    }
}
const SOLVER_PERSONAS = [
    {
        id: 'cow-solver-01',
        name: 'CoW Solver Alpha',
        protocol: 'CoW Protocol',
        description: 'Batch auction solver using CoW Protocol. Excels at stable-to-stable swaps with minimal slippage.',
        wallet: ethers_1.ethers.Wallet.createRandom(),
        feeRateBps: 5, // 0.05% fee — very competitive
        latencyMs: 800, // 0.8s response time
        successRate: 0.95,
        specialization: 'stable-pairs',
    },
    {
        id: 'uniswapx-solver-01',
        name: 'UniswapX Filler',
        protocol: 'UniswapX',
        description: 'Dutch auction filler using UniswapX. Competitive on volatile pairs with dynamic pricing.',
        wallet: ethers_1.ethers.Wallet.createRandom(),
        feeRateBps: 8, // 0.08% fee
        latencyMs: 600, // 0.6s response time — fastest
        successRate: 0.90,
        specialization: 'volatile-pairs',
    },
    {
        id: 'hief-native-solver-01',
        name: 'HIEF Native Solver',
        protocol: 'HIEF Native',
        description: 'HIEF\'s own solver with reputation-aware pricing. Trusted users get better rates.',
        wallet: ethers_1.ethers.Wallet.createRandom(),
        feeRateBps: 3, // 0.03% fee — cheapest for trusted users
        latencyMs: 1200, // 1.2s response time — slower but better price
        successRate: 0.85,
        specialization: 'reputation-aware',
    },
];
// ─── Token Price Oracle (mock) ─────────────────────────────────────────────────
const TOKEN_PRICES_USD = {
    USDC: 1.0,
    USDT: 1.0,
    DAI: 1.0,
    WETH: 2650.0,
    ETH: 2650.0,
    WBTC: 67000.0,
};
function getTokenPrice(symbol) {
    return TOKEN_PRICES_USD[symbol.toUpperCase()] ?? 1.0;
}
function extractTokenSymbol(tokenAddr, intent) {
    // Priority 1: uiHints from intent metadata
    const hints = intent.meta?.uiHints || {};
    // Will be resolved by caller context (input vs output)
    // Priority 2: address mapping
    const addrMap = {
        '0x036CbD53842c5426634e7929541eC2318f3dCF7e': 'USDC',
        '0x4200000000000000000000000000000000000006': 'WETH',
        '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE': 'ETH',
        '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb': 'DAI',
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 'USDC',
        '0x0000000000000000000000000000000000000000': 'ETH',
    };
    const sym = addrMap[tokenAddr];
    if (sym)
        return sym;
    // Priority 3: from intent text
    const text = intent.userIntentText || intent.meta?.userIntentText || '';
    const match = text.match(/\b(USDC|USDT|DAI|WETH|ETH|WBTC)\b/gi);
    if (match)
        return match[match.length - 1].toUpperCase();
    return 'UNKNOWN';
}
function extractInputToken(intent) {
    const hints = intent.meta?.uiHints || {};
    if (hints.inputTokenSymbol)
        return hints.inputTokenSymbol.toUpperCase();
    return extractTokenSymbol(intent.input?.token || '', intent);
}
function extractOutputToken(intent) {
    const hints = intent.meta?.uiHints || {};
    if (hints.outputTokenSymbol)
        return hints.outputTokenSymbol.toUpperCase();
    return extractTokenSymbol(intent.outputs?.[0]?.token || '', intent);
}
function extractInputAmount(intent) {
    const hints = intent.meta?.uiHints || {};
    if (hints.inputAmountHuman)
        return parseFloat(hints.inputAmountHuman);
    // USDC has 6 decimals, ETH/WETH has 18
    const raw = parseFloat(intent.input?.amount || '0');
    const tokenSym = extractInputToken(intent);
    if (tokenSym === 'USDC' || tokenSym === 'USDT')
        return raw / 1e6;
    return raw / 1e18;
}
async function generateQuote(solver, intent, inputAmountUSD, outputTokenSymbol) {
    // Simulate network latency
    await new Promise(r => setTimeout(r, solver.latencyMs + Math.random() * 200));
    // Random failure simulation
    if (Math.random() > solver.successRate) {
        return {
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
            status: 'FAILED',
            error: 'Liquidity not available',
        };
    }
    const outputPrice = getTokenPrice(outputTokenSymbol);
    // Each solver has slightly different pricing
    // CoW: better for stable pairs (lower price impact)
    // UniswapX: faster but slightly higher impact
    // HIEF Native: best price but slower
    let priceImpactBps;
    let feeRateBps = solver.feeRateBps;
    if (solver.protocol === 'CoW Protocol') {
        priceImpactBps = 5 + Math.random() * 10; // 0.05-0.15% impact
    }
    else if (solver.protocol === 'UniswapX') {
        priceImpactBps = 8 + Math.random() * 15; // 0.08-0.23% impact
    }
    else {
        // HIEF Native — best price
        priceImpactBps = 3 + Math.random() * 8; // 0.03-0.11% impact
        // Reputation bonus: trusted users get 50% fee discount
        const reputationTier = intent.reputationTier || 'STANDARD';
        if (reputationTier === 'TRUSTED' || reputationTier === 'ELITE') {
            feeRateBps = Math.floor(feeRateBps * 0.5);
        }
    }
    const totalCostBps = priceImpactBps + feeRateBps;
    const netOutputUSD = inputAmountUSD * (1 - totalCostBps / 10000);
    const feeUSD = inputAmountUSD * (feeRateBps / 10000);
    // Convert to output token units (18 decimals)
    const outputAmount = netOutputUSD / outputPrice;
    const outputAmountWei = BigInt(Math.floor(outputAmount * 1e18));
    const feeAmountWei = BigInt(Math.floor((feeUSD / outputPrice) * 1e18));
    const validUntil = Math.floor(Date.now() / 1000) + 300; // 5 min validity
    // Route description
    let route;
    if (solver.protocol === 'CoW Protocol') {
        route = `CoW Batch → ${outputTokenSymbol}`;
    }
    else if (solver.protocol === 'UniswapX') {
        route = `UniswapX Dutch → ${outputTokenSymbol}`;
    }
    else {
        route = `HIEF AMM → ${outputTokenSymbol}`;
    }
    return {
        solverId: solver.id,
        solverName: solver.name,
        protocol: solver.protocol,
        expectedOut: outputAmountWei.toString(),
        expectedOutUSD: netOutputUSD + feeUSD, // gross output
        fee: feeAmountWei.toString(),
        feeUSD,
        netOutUSD: netOutputUSD,
        validUntil,
        latencyMs: solver.latencyMs,
        priceImpactBps,
        route,
        status: 'QUOTED',
    };
}
async function runAuction(intentId, intentHash, intent) {
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
    const quotePromises = SOLVER_PERSONAS.map(solver => generateQuote(solver, enrichedIntent, inputAmountUSD, outputToken)
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
        status: 'FAILED',
        error: err.message,
    })));
    const quotes = await Promise.all(quotePromises);
    const auctionDurationMs = Date.now() - startTime;
    // Select winner: highest netOutUSD among valid quotes
    const validQuotes = quotes.filter(q => q.status === 'QUOTED' && q.validUntil > Math.floor(Date.now() / 1000));
    validQuotes.sort((a, b) => b.netOutUSD - a.netOutUSD);
    const winner = validQuotes[0] || null;
    let winnerReason = 'No valid quotes';
    let submittedSolutionId = null;
    if (winner) {
        const margin = validQuotes.length > 1
            ? ((winner.netOutUSD - validQuotes[1].netOutUSD) / validQuotes[1].netOutUSD * 100).toFixed(3)
            : 'N/A';
        winnerReason = `Best net output: $${winner.netOutUSD.toFixed(4)} (+${margin}% vs runner-up)`;
        // Build and submit solution to Intent Bus
        const winnerSolver = SOLVER_PERSONAS.find(s => s.id === winner.solverId);
        const solutionId = ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32));
        const solution = {
            solutionVersion: '0.1',
            solutionId,
            intentId,
            intentHash,
            solverId: winnerSolver.wallet.address,
            executionPlan: {
                calls: [
                    {
                        to: intent.outputs?.[0]?.token || '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
                        value: winner.expectedOut,
                        data: '0x',
                        operation: 'CALL',
                    },
                ],
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
            const resJson = await res.json();
            if (res.ok) {
                submittedSolutionId = solutionId;
                console.log(`[SolverNetwork] ✅ Winner: ${winner.solverName} | net=$${winner.netOutUSD.toFixed(4)} | tx submitted`);
                // Auto-select the winning solution
                await fetch(`${BUS_URL}/v1/intents/${intentId}/select`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ solutionId }),
                });
            }
            else {
                console.warn(`[SolverNetwork] ⚠️ Solution submission failed: ${JSON.stringify(resJson)}`);
            }
        }
        catch (err) {
            console.error(`[SolverNetwork] ❌ Failed to submit solution: ${err.message}`);
        }
    }
    else {
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
const processedIntents = new Set();
const auctionHistory = [];
let isPolling = false;
let totalAuctions = 0;
let totalWins = 0;
async function pollAndAuction() {
    if (isPolling)
        return;
    isPolling = true;
    try {
        const res = await fetch(`${BUS_URL}/v1/intents?status=BROADCAST&limit=20`);
        if (!res.ok) {
            isPolling = false;
            return;
        }
        const json = await res.json();
        const intents = json.data || [];
        for (const intentRow of intents) {
            if (processedIntents.has(intentRow.id))
                continue;
            processedIntents.add(intentRow.id);
            totalAuctions++;
            // Get full intent details
            try {
                const detailRes = await fetch(`http://localhost:3006/v1/explorer/intents/${intentRow.id}`);
                if (!detailRes.ok)
                    continue;
                const detail = await detailRes.json();
                const intentData = detail.data;
                const intent = intentData?.intent || {};
                const intentHash = intentData?.intentHash || '';
                const result = await runAuction(intentRow.id, intentHash, intent);
                if (result.submittedSolutionId)
                    totalWins++;
                auctionHistory.unshift(result);
                if (auctionHistory.length > 50)
                    auctionHistory.pop();
            }
            catch (err) {
                console.error(`[SolverNetwork] Error processing intent ${intentRow.id}:`, err.message);
            }
        }
    }
    catch (err) {
        console.error('[SolverNetwork] Poll error:', err.message);
    }
    finally {
        isPolling = false;
    }
}
// ─── Express Server ───────────────────────────────────────────────────────────
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get('/health', (_req, res) => {
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
app.get('/v1/solver-network/solvers', (_req, res) => {
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
app.get('/v1/solver-network/auctions', (req, res) => {
    const limit = parseInt(req.query.limit || '20', 10);
    res.json({
        success: true,
        data: auctionHistory.slice(0, limit),
        meta: { total: auctionHistory.length, totalAuctions, totalWins },
    });
});
// POST /v1/solver-network/quote — request quotes for a hypothetical intent
app.post('/v1/solver-network/quote', async (req, res) => {
    const { inputToken, outputToken, inputAmount, reputationTier = 'STANDARD' } = req.body;
    if (!inputToken || !outputToken || !inputAmount) {
        res.status(400).json({ success: false, error: 'inputToken, outputToken, inputAmount required' });
        return;
    }
    const inputAmountUSD = parseFloat(inputAmount) * getTokenPrice(inputToken);
    const mockIntent = { userIntentText: `swap ${inputAmount} ${inputToken} to ${outputToken}`, reputationTier };
    const quotePromises = SOLVER_PERSONAS.map(solver => generateQuote(solver, mockIntent, inputAmountUSD, outputToken));
    const quotes = await Promise.all(quotePromises);
    const validQuotes = quotes.filter(q => q.status === 'QUOTED').sort((a, b) => b.netOutUSD - a.netOutUSD);
    res.json({
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
    });
});
// POST /v1/solver-network/trigger — manually trigger auction for a specific intent
app.post('/v1/solver-network/trigger', async (req, res) => {
    const { intentId } = req.body;
    if (!intentId) {
        res.status(400).json({ success: false, error: 'intentId required' });
        return;
    }
    try {
        const detailRes = await fetch(`http://localhost:3006/v1/explorer/intents/${intentId}`);
        if (!detailRes.ok) {
            res.status(404).json({ success: false, error: 'Intent not found' });
            return;
        }
        const detail = await detailRes.json();
        const intentData = detail.data;
        const intent = intentData?.intent || {};
        const intentHash = intentData?.intentHash || '';
        // Remove from processed set to allow re-auction
        processedIntents.delete(intentId);
        const result = await runAuction(intentId, intentHash, intent);
        if (result.submittedSolutionId)
            totalWins++;
        totalAuctions++;
        auctionHistory.unshift(result);
        if (auctionHistory.length > 50)
            auctionHistory.pop();
        res.json({ success: true, data: result });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[SolverNetwork] Service started on port ${PORT}`);
    console.log(`[SolverNetwork] ${SOLVER_PERSONAS.length} solvers registered: ${SOLVER_PERSONAS.map(s => s.name).join(', ')}`);
    console.log(`[SolverNetwork] Polling Intent Bus at ${BUS_URL} every ${POLL_INTERVAL_MS}ms`);
    // Initial poll
    setTimeout(pollAndAuction, 2000);
    setInterval(pollAndAuction, POLL_INTERVAL_MS);
});
