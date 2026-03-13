"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntentParser = void 0;
const openai_1 = __importDefault(require("openai"));
const zod_1 = require("zod");
const tokenRegistry_1 = require("../tools/tokenRegistry");
const systemPrompt_1 = require("../prompts/systemPrompt");
const ethers_1 = require("ethers");
// ─── Zod schema for LLM output validation ─────────────────────────────────────
const ParseResultSchema = zod_1.z.object({
    intentType: zod_1.z.enum([
        'SWAP', 'DEPOSIT', 'WITHDRAW',
        'BRIDGE', 'PROVIDE_LIQUIDITY', 'REMOVE_LIQUIDITY',
        'STAKE', 'UNSTAKE', 'UNKNOWN',
    ]),
    confidence: zod_1.z.number().min(0).max(1),
    params: zod_1.z.object({
        inputToken: zod_1.z.string().nullable(),
        inputAmount: zod_1.z.string().nullable(),
        outputToken: zod_1.z.string().nullable(),
        minOutputAmount: zod_1.z.string().nullable(),
        slippageBps: zod_1.z.number().nullable(),
        deadline: zod_1.z.number().nullable(),
        targetChain: zod_1.z.string().nullable(),
        protocol: zod_1.z.string().nullable(),
        extraParams: zod_1.z.record(zod_1.z.unknown()).default({}),
    }),
    missingFields: zod_1.z.array(zod_1.z.string()),
    clarificationNeeded: zod_1.z.boolean(),
    clarificationQuestion: zod_1.z.string().nullable(),
    rawIntent: zod_1.z.string(),
});
// ─── IntentParser class ───────────────────────────────────────────────────────
class IntentParser {
    client;
    model;
    defaultChainId;
    constructor(options = {}) {
        this.client = new openai_1.default({
            apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
            baseURL: process.env.OPENAI_BASE_URL,
        });
        this.model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
        this.defaultChainId = options.defaultChainId ?? 8453; // Base
    }
    /**
     * Parse a natural language DeFi instruction into structured parameters.
     */
    async parse(userMessage) {
        const completion = await this.client.chat.completions.create({
            model: this.model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: systemPrompt_1.INTENT_EXTRACTION_SYSTEM_PROMPT },
                { role: 'user', content: userMessage },
            ],
        });
        const raw = completion.choices[0]?.message?.content;
        if (!raw)
            throw new Error('LLM returned empty response');
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
        }
        const validated = ParseResultSchema.safeParse(parsed);
        if (!validated.success) {
            console.warn('[PARSER] Schema validation warning:', validated.error.issues);
            // Attempt lenient parse
            return parsed;
        }
        return validated.data;
    }
    /**
     * Parse AND resolve token addresses to produce a HIEFIntent.
     * Returns the parse result plus a fully formed HIEFIntent (if all params resolved).
     */
    async parseAndResolve(userMessage, smartAccount, chainId) {
        const chain = chainId ?? this.defaultChainId;
        const parseResult = await this.parse(userMessage);
        const resolveErrors = [];
        // If clarification is needed, return early
        if (parseResult.clarificationNeeded || parseResult.intentType === 'UNKNOWN') {
            return { parseResult, resolveErrors };
        }
        // MVP supports: SWAP and DEPOSIT
        if (parseResult.intentType !== 'SWAP' && parseResult.intentType !== 'DEPOSIT') {
            resolveErrors.push(`Intent type "${parseResult.intentType}" is not yet supported. Supported: SWAP, DEPOSIT (Aave).`);
            return { parseResult, resolveErrors };
        }
        const { params } = parseResult;
        // Resolve input token
        if (!params.inputToken) {
            resolveErrors.push('Input token is required');
            return { parseResult, resolveErrors };
        }
        const inputTokenInfo = (0, tokenRegistry_1.resolveToken)(params.inputToken, chain);
        if (!inputTokenInfo) {
            resolveErrors.push(`Unknown token: "${params.inputToken}" on chain ${chain}`);
            return { parseResult, resolveErrors };
        }
        // Resolve output token
        // For DEPOSIT intents the "output" is the receipt token (aToken).
        // If not specified, use a placeholder — the solver will fill the real aToken address.
        const isDeposit = parseResult.intentType === 'DEPOSIT';
        let outputTokenAddress = '0x0000000000000000000000000000000000000000'; // filled by solver
        let outputTokenSymbol = isDeposit ? `a${inputTokenInfo.symbol}` : '';
        if (!isDeposit) {
            if (!params.outputToken) {
                resolveErrors.push('Output token is required');
                return { parseResult, resolveErrors };
            }
            const outputTokenInfo = (0, tokenRegistry_1.resolveToken)(params.outputToken, chain);
            if (!outputTokenInfo) {
                resolveErrors.push(`Unknown token: "${params.outputToken}" on chain ${chain}`);
                return { parseResult, resolveErrors };
            }
            outputTokenAddress = outputTokenInfo.address;
            outputTokenSymbol = outputTokenInfo.symbol;
        }
        else if (params.outputToken) {
            // User may specify the protocol token (e.g. "aUSDC") — try to resolve
            const outputTokenInfo = (0, tokenRegistry_1.resolveToken)(params.outputToken, chain);
            if (outputTokenInfo) {
                outputTokenAddress = outputTokenInfo.address;
                outputTokenSymbol = outputTokenInfo.symbol;
            }
        }
        // Resolve amount
        if (!params.inputAmount) {
            resolveErrors.push('Input amount is required');
            return { parseResult, resolveErrors };
        }
        let rawInputAmount;
        if (params.inputAmount === 'ALL') {
            // Placeholder — in production, query on-chain balance
            resolveErrors.push('Amount "ALL" requires on-chain balance query. Please specify an exact amount.');
            return { parseResult, resolveErrors };
        }
        try {
            rawInputAmount = (0, tokenRegistry_1.parseAmount)(params.inputAmount, inputTokenInfo.decimals);
        }
        catch (err) {
            resolveErrors.push(`Invalid amount: ${err.message}`);
            return { parseResult, resolveErrors };
        }
        // Compute deadline
        const deadlineSeconds = params.deadline ?? 3600;
        const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;
        // Compute slippage
        const slippageBps = params.slippageBps ?? 50;
        // Compute minimum output — DEPOSIT is 1:1 so min = input amount; SWAP uses user's spec
        let minOutputRaw = '0';
        if (isDeposit) {
            minOutputRaw = rawInputAmount; // expect at least the same amount back as aTokens
        }
        else if (params.minOutputAmount) {
            try {
                minOutputRaw = (0, tokenRegistry_1.parseAmount)(params.minOutputAmount, inputTokenInfo.decimals);
            }
            catch {
                // Non-fatal: use 0 as min
            }
        }
        // Build HIEFIntent
        const intentId = ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32));
        const hief = {
            intentVersion: '0.1',
            intentId,
            smartAccount,
            chainId: chain,
            deadline,
            input: {
                token: inputTokenInfo.address,
                amount: rawInputAmount,
            },
            outputs: [
                {
                    token: outputTokenAddress,
                    minAmount: minOutputRaw,
                },
            ],
            constraints: {
                slippageBps: isDeposit ? 0 : slippageBps, // deposits are 1:1, no slippage
            },
            priorityFee: { token: 'HIEF', amount: '0' },
            policyRef: { policyVersion: 'v0.1' },
            signature: {
                type: 'EIP712_EOA',
                signer: smartAccount,
                sig: '0x', // Will be signed by user
            },
            meta: {
                userIntentText: userMessage,
                tags: [parseResult.intentType, inputTokenInfo.symbol, outputTokenSymbol],
                uiHints: {
                    inputTokenSymbol: inputTokenInfo.symbol,
                    outputTokenSymbol,
                    inputAmountHuman: params.inputAmount,
                    protocol: params.protocol ?? (isDeposit ? 'aave' : 'auto'),
                },
            },
        };
        return { parseResult, hief, resolveErrors };
    }
}
exports.IntentParser = IntentParser;
//# sourceMappingURL=intentParser.js.map