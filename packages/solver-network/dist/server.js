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
const safeMultisig_1 = require("./safeMultisig");
// ─── Config ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3008', 10);
const BUS_URL = process.env.BUS_URL || 'http://localhost:3001';
const TENDERLY_RPC_URL = process.env.TENDERLY_RPC_URL || 'https://virtual.base-sepolia.eu.rpc.tenderly.co/2aec27b5-9066-421e-a62d-31e1661403d9';
const SETTLEMENT_CHAIN_ID = parseInt(process.env.SETTLEMENT_CHAIN_ID || '99917', 10);
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
// ─── Settlement Engine ───────────────────────────────────────────────────────
// Tenderly Virtual Testnet config (Base Sepolia fork, chainId 99917)
const TENDERLY_RPC = process.env.TENDERLY_RPC_URL ||
    'https://virtual.base-sepolia.eu.rpc.tenderly.co/2aec27b5-9066-421e-a62d-31e1661403d9';
const SETTLEMENT_PRIVATE_KEY = process.env.SETTLEMENT_PRIVATE_KEY ||
    '0x657a363c86654cbe2ff0136725d8361892fb7d48db2a1ae4abdd85a661d7a611';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const WETH_ABI = [
    'function deposit() payable',
    'function balanceOf(address) view returns (uint256)',
];
const ERC20_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
];
async function simulateSettlement(intent, winner) {
    const inputToken = (intent.input?.token || '').toLowerCase();
    const outputToken = (intent.outputs?.[0]?.token || '').toLowerCase();
    const isUsdcToEth = inputToken === USDC_ADDRESS.toLowerCase() &&
        (outputToken === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
            outputToken === WETH_ADDRESS.toLowerCase());
    // Build the transaction calldata for the main settlement step
    const WETH_DEPOSIT_SELECTOR = '0xd0e30db0'; // deposit()
    const ethAmount = winner?.netOutUSD
        ? Math.max(0.0001, winner.netOutUSD / 2650)
        : 0.0377;
    const ethAmountWei = BigInt(Math.floor(ethAmount * 1e18));
    const valueHex = '0x' + ethAmountWei.toString(16);
    // Use tenderly_simulateTransaction RPC method (no API key needed, uses fork RPC)
    const simPayload = {
        jsonrpc: '2.0',
        method: 'tenderly_simulateTransaction',
        params: [
            {
                from: '0xB67FAfFB8eB9a1972E424bcc51B70Fd6f2d25f8a',
                to: WETH_ADDRESS,
                data: WETH_DEPOSIT_SELECTOR,
                value: valueHex,
                gas: '0x493E0', // 300000
            },
            'latest',
        ],
        id: 1,
    };
    const simRes = await fetch(TENDERLY_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(simPayload),
    });
    const simJson = await simRes.json();
    if (simJson.error) {
        return {
            success: false,
            gasUsed: 0,
            gasEstimateUSD: 0,
            expectedOutputToken: 'WETH',
            expectedOutputAmount: '0',
            expectedOutputAmountRaw: '0',
            expectedOutputUSD: 0,
            priceImpactBps: winner?.priceImpactBps ?? 0,
            balanceChanges: [],
            simulatedBlock: 0,
            error: simJson.error.message || 'Simulation failed',
        };
    }
    const result = simJson.result || {};
    const gasUsed = parseInt(result.gasUsed || '0x0', 16);
    // Estimate gas cost: ~0.000000001 ETH/gas on Base (1 gwei), ETH ≈ $2650
    const gasEstimateUSD = (gasUsed * 1e-9 * 2650);
    // Parse Deposit event from logs to get actual output amount
    let wethReceived = ethAmountWei;
    const logs = result.logs || [];
    for (const log of logs) {
        if (log.name === 'Deposit') {
            const wadInput = log.inputs?.find((i) => i.name === 'wad');
            if (wadInput)
                wethReceived = BigInt(wadInput.value);
        }
    }
    const wethReceivedHuman = (Number(wethReceived) / 1e18).toFixed(6);
    const wethUSD = Number(wethReceived) / 1e18 * 2650;
    // Build balance changes summary
    const balanceChanges = [];
    if (isUsdcToEth) {
        const inputAmountRaw = BigInt(intent.input?.amount || '100000000');
        const inputAmountHuman = (Number(inputAmountRaw) / 1e6).toFixed(2);
        balanceChanges.push({
            token: USDC_ADDRESS,
            symbol: 'USDC',
            delta: '-' + inputAmountHuman,
            deltaUSD: -parseFloat(inputAmountHuman),
        });
    }
    balanceChanges.push({
        token: WETH_ADDRESS,
        symbol: 'WETH',
        delta: '+' + wethReceivedHuman,
        deltaUSD: wethUSD,
    });
    console.log(`[Simulation] ✅ Success | gasUsed: ${gasUsed} (~$${gasEstimateUSD.toFixed(4)}) | WETH out: ${wethReceivedHuman}`);
    return {
        success: result.status === true,
        gasUsed,
        gasEstimateUSD,
        expectedOutputToken: 'WETH',
        expectedOutputAmount: wethReceivedHuman,
        expectedOutputAmountRaw: wethReceived.toString(),
        expectedOutputUSD: wethUSD,
        priceImpactBps: winner?.priceImpactBps ?? 0,
        balanceChanges,
        simulatedBlock: parseInt(result.blockNumber || '0x0', 16),
    };
}
/**
 * Execute settlement on Tenderly fork.
 * For USDC→ETH intents: transfer USDC to burn address + wrap ETH to WETH.
 * For other intents: wrap a small amount of ETH to WETH as proof-of-execution.
 */
async function settleOnChain(intent, winner) {
    const provider = new ethers_1.ethers.JsonRpcProvider(TENDERLY_RPC);
    const wallet = new ethers_1.ethers.Wallet(SETTLEMENT_PRIVATE_KEY, provider);
    const inputToken = (intent.input?.token || '').toLowerCase();
    const outputToken = (intent.outputs?.[0]?.token || '').toLowerCase();
    const isUsdcToEth = inputToken === USDC_ADDRESS.toLowerCase() &&
        (outputToken === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
            outputToken === WETH_ADDRESS.toLowerCase());
    let txHash = '';
    let blockNumber = 0;
    if (isUsdcToEth) {
        // Step 1: Transfer input USDC to burn address (representing USDC spent)
        const inputAmount = BigInt(intent.input?.amount || '100000000');
        const usdc = new ethers_1.ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
        const usdcBal = await usdc.balanceOf(wallet.address);
        const transferAmount = usdcBal < inputAmount ? usdcBal : inputAmount;
        if (transferAmount > 0n) {
            const tx1 = await usdc.transfer(BURN_ADDRESS, transferAmount);
            const r1 = await tx1.wait();
            console.log(`[Settlement] USDC transfer tx: ${tx1.hash} | block: ${r1?.blockNumber}`);
        }
        // Step 2: Wrap ETH to WETH (representing ETH received by solver)
        const ethAmount = winner?.netOutUSD
            ? ethers_1.ethers.parseEther(Math.max(0.0001, winner.netOutUSD / 2650).toFixed(6))
            : ethers_1.ethers.parseEther('0.0377');
        const weth = new ethers_1.ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);
        const tx2 = await weth.deposit({ value: ethAmount });
        const r2 = await tx2.wait();
        txHash = tx2.hash;
        blockNumber = r2?.blockNumber ?? 0;
        console.log(`[Settlement] WETH wrap tx: ${txHash} | block: ${blockNumber}`);
    }
    else {
        // Generic settlement: wrap 0.001 ETH to WETH as proof-of-execution
        const weth = new ethers_1.ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);
        const tx = await weth.deposit({ value: ethers_1.ethers.parseEther('0.001') });
        const r = await tx.wait();
        txHash = tx.hash;
        blockNumber = r?.blockNumber ?? 0;
        console.log(`[Settlement] Generic settlement tx: ${txHash} | block: ${blockNumber}`);
    }
    return { txHash, blockNumber };
}
// In-memory store for pending simulations awaiting user confirmation
// intentId -> { intent, winner, simulation, accountInfo }
const pendingSimulations = new Map();
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
    let settlementTxHash;
    let settlementBlock;
    let settlementStatus;
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
                // ─── Simulation Layer ─────────────────────────────────────────────────────
                // Step 1: Detect account execution mode (DIRECT vs MULTISIG)
                const smartAccount = intent.sender || intent.smartAccount || '';
                let accountInfo;
                let executionMode = 'DIRECT';
                if (smartAccount && smartAccount.startsWith('0x')) {
                    try {
                        accountInfo = await (0, safeMultisig_1.detectAccountMode)(smartAccount, TENDERLY_RPC_URL, SETTLEMENT_CHAIN_ID);
                        executionMode = accountInfo.mode;
                        console.log(`[SolverNetwork] Account mode: ${executionMode} | threshold: ${accountInfo.threshold} | isSafe: ${accountInfo.isSafe}`);
                    }
                    catch (modeErr) {
                        console.warn(`[SolverNetwork] Account mode detection failed, defaulting to DIRECT: ${modeErr.message}`);
                    }
                }
                // Step 2: Simulate settlement (both modes run simulation first)
                console.log(`[Simulation] Running pre-settlement simulation for ${intentId.slice(0, 16)}... (mode: ${executionMode})`);
                try {
                    const simResult = await simulateSettlement(intent, winner);
                    if (executionMode === 'MULTISIG' && accountInfo?.isSafe) {
                        // ─── MULTISIG MODE ────────────────────────────────────────────────────
                        // Propose Safe transaction — AI proposes, co-signers must approve
                        console.log(`[SafeMultisig] Proposing Safe TX for ${intentId.slice(0, 16)}... | threshold: ${accountInfo.threshold}`);
                        let multisigProposal;
                        try {
                            // Build settlement calldata (WETH wrap as representative tx)
                            const wethInterface = new ethers_1.ethers.Interface(['function deposit() payable']);
                            const depositData = wethInterface.encodeFunctionData('deposit', []);
                            const proposal = await (0, safeMultisig_1.proposeSafeMultisig)({
                                safeAddress: smartAccount,
                                chainId: SETTLEMENT_CHAIN_ID,
                                rpcUrl: TENDERLY_RPC_URL,
                                proposerPrivateKey: SETTLEMENT_PRIVATE_KEY,
                                to: WETH_ADDRESS,
                                value: ethers_1.ethers.parseEther('0.001').toString(),
                                data: depositData,
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
                            }).catch(() => { });
                            console.log(`[SafeMultisig] ✅ Proposal ready | safeTxHash: ${multisigProposal.safeTxHash.slice(0, 16)}... | threshold: ${accountInfo.threshold} | awaiting co-signatures`);
                        }
                        catch (msErr) {
                            console.error(`[SafeMultisig] ❌ Proposal failed: ${msErr.message}. Falling back to DIRECT mode.`);
                            executionMode = 'DIRECT';
                            pendingSimulations.set(intentId, { intent, winner, simulation: simResult, accountInfo });
                            await fetch(`${BUS_URL}/v1/intents/${intentId}/simulate`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ simulation: simResult, executionMode: 'DIRECT' }),
                            }).catch(() => { });
                        }
                        return {
                            intentId, intentHash, quotes, winner, winnerReason, auctionDurationMs,
                            submittedSolutionId, submittedAt: Math.floor(Date.now() / 1000),
                            simulation: simResult, executionMode: 'MULTISIG', accountInfo, multisigProposal,
                        };
                    }
                    else {
                        // ─── DIRECT MODE ──────────────────────────────────────────────────────
                        // Store pending simulation so user can confirm
                        pendingSimulations.set(intentId, { intent, winner, simulation: simResult, accountInfo });
                        // Notify Intent Bus of simulation result
                        await fetch(`${BUS_URL}/v1/intents/${intentId}/simulate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ simulation: simResult, executionMode: 'DIRECT' }),
                        }).catch(() => { });
                        console.log(`[Simulation] ✅ Simulation complete | gasUsed: ${simResult.gasUsed} | expectedOut: ${simResult.expectedOutputAmount} WETH | mode: DIRECT | awaiting user confirmation`);
                        return {
                            intentId, intentHash, quotes, winner, winnerReason, auctionDurationMs,
                            submittedSolutionId, submittedAt: Math.floor(Date.now() / 1000),
                            simulation: simResult, executionMode: 'DIRECT', accountInfo,
                        };
                    }
                }
                catch (simErr) {
                    console.error(`[Simulation] ❌ Simulation failed: ${simErr.message}`);
                    // Fall through — return without simulation
                }
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
// GET /v1/solver-network/simulation/:intentId — get pending simulation result
app.get('/v1/solver-network/simulation/:intentId', (req, res) => {
    const { intentId } = req.params;
    const pending = pendingSimulations.get(intentId);
    if (!pending) {
        res.status(404).json({ success: false, error: 'No pending simulation for this intent' });
        return;
    }
    res.json({
        success: true,
        data: {
            intentId,
            simulation: pending.simulation,
            winner: pending.winner,
            accountInfo: pending.accountInfo,
            executionMode: pending.accountInfo?.mode || 'DIRECT',
        },
    });
});
// POST /v1/solver-network/execute/:intentId — user confirms, execute real settlement
// Works for both DIRECT mode (broadcasts immediately) and MULTISIG mode (marks as PENDING_SIGNATURES)
app.post('/v1/solver-network/execute/:intentId', async (req, res) => {
    const { intentId } = req.params;
    const pending = pendingSimulations.get(intentId);
    if (!pending) {
        res.status(404).json({ success: false, error: 'No pending simulation for this intent. Run trigger first.' });
        return;
    }
    const { intent, winner, accountInfo } = pending;
    const isMultisig = accountInfo?.mode === 'MULTISIG' && accountInfo?.isSafe;
    if (isMultisig) {
        // ─── MULTISIG MODE: Propose Safe TX, wait for co-signatures ──────────────────────────────
        try {
            console.log(`[SafeMultisig] User confirmed multisig proposal for ${intentId.slice(0, 16)}... Proposing Safe TX...`);
            const wethInterface = new ethers_1.ethers.Interface(['function deposit() payable']);
            const depositData = wethInterface.encodeFunctionData('deposit', []);
            const proposal = await (0, safeMultisig_1.proposeSafeMultisig)({
                safeAddress: accountInfo.address,
                chainId: SETTLEMENT_CHAIN_ID,
                rpcUrl: TENDERLY_RPC_URL,
                proposerPrivateKey: SETTLEMENT_PRIVATE_KEY,
                to: WETH_ADDRESS,
                value: ethers_1.ethers.parseEther('0.001').toString(),
                data: depositData,
                intentId,
            });
            const multisigProposal = { ...proposal, threshold: accountInfo.threshold };
            pendingSimulations.delete(intentId);
            // Notify Intent Bus: status → PENDING_SIGNATURES
            await fetch(`${BUS_URL}/v1/intents/${intentId}/multisig-propose`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ multisigProposal }),
            }).catch(() => { });
            // Update auction history
            const historyEntry = auctionHistory.find(a => a.intentId === intentId);
            if (historyEntry) {
                historyEntry.multisigProposal = multisigProposal;
                historyEntry.executionMode = 'MULTISIG';
            }
            console.log(`[SafeMultisig] ✅ Proposal submitted | safeTxHash: ${multisigProposal.safeTxHash.slice(0, 16)}... | threshold: ${accountInfo.threshold}`);
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
                },
            });
        }
        catch (err) {
            console.error(`[SafeMultisig] ❌ Proposal failed: ${err.message}`);
            res.status(500).json({ success: false, error: err.message });
        }
    }
    else {
        // ─── DIRECT MODE: Broadcast immediately ────────────────────────────────────────────────────
        try {
            console.log(`[Settlement] User confirmed DIRECT execution for ${intentId.slice(0, 16)}... Broadcasting real tx...`);
            const { txHash, blockNumber } = await settleOnChain(intent, winner);
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
                data: { intentId, executionMode: 'DIRECT', txHash, blockNumber, status: 'EXECUTED' },
            });
        }
        catch (err) {
            console.error(`[Settlement] ❌ Execution failed: ${err.message}`);
            pendingSimulations.delete(intentId);
            await fetch(`${BUS_URL}/v1/intents/${intentId}/settle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ txHash: '0x' + '0'.repeat(64), txStatus: 'failed' }),
            }).catch(() => { });
            res.status(500).json({ success: false, error: err.message });
        }
    }
});
// POST /v1/solver-network/multisig-confirm/:intentId — co-signer confirmed, execute the Safe TX on-chain
// Called after all required signatures are collected (or for testing: force-execute)
app.post('/v1/solver-network/multisig-confirm/:intentId', async (req, res) => {
    const { intentId } = req.params;
    // For the Tenderly fork demo: we execute the settlement tx directly since Safe TX Service
    // can't execute on a virtual testnet. In production this would relay via Safe Relay.
    try {
        // Re-fetch intent from bus to get the stored multisig proposal
        const detailRes = await fetch(`http://localhost:3006/v1/explorer/intents/${intentId}`);
        if (!detailRes.ok) {
            res.status(404).json({ success: false, error: 'Intent not found' });
            return;
        }
        const detail = await detailRes.json();
        const intentData = detail.data;
        const intent = intentData?.intent || {};
        // Execute on Tenderly fork (simulating Safe execution)
        const provider = new ethers_1.ethers.JsonRpcProvider(TENDERLY_RPC_URL);
        const wallet = new ethers_1.ethers.Wallet(SETTLEMENT_PRIVATE_KEY, provider);
        const wethContract = new ethers_1.ethers.Contract(WETH_ADDRESS, ['function deposit() payable'], wallet);
        const tx = await wethContract.deposit({ value: ethers_1.ethers.parseEther('0.001') });
        const receipt = await tx.wait();
        const txHash = receipt?.hash || tx.hash;
        const blockNumber = receipt?.blockNumber || 0;
        // Notify Intent Bus: EXECUTED
        await fetch(`${BUS_URL}/v1/intents/${intentId}/settle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txHash, txStatus: 'success' }),
        });
        console.log(`[SafeMultisig] ✅ Multisig EXECUTED | txHash: ${txHash} | block: ${blockNumber}`);
        res.json({
            success: true,
            data: { intentId, executionMode: 'MULTISIG', txHash, blockNumber, status: 'EXECUTED' },
        });
    }
    catch (err) {
        console.error(`[SafeMultisig] ❌ Multisig execution failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});
// ─── Start ───────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[SolverNetwork] Service started on port ${PORT}`);
    console.log(`[SolverNetwork] ${SOLVER_PERSONAS.length} solvers registered: ${SOLVER_PERSONAS.map(s => s.name).join(', ')}`);
    console.log(`[SolverNetwork] Polling Intent Bus at ${BUS_URL} every ${POLL_INTERVAL_MS}ms`);
    // Initial poll
    setTimeout(pollAndAuction, 2000);
    setInterval(pollAndAuction, POLL_INTERVAL_MS);
});
