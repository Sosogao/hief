"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationEngine = void 0;
const openai_1 = __importDefault(require("openai"));
const intentParser_1 = require("../parser/intentParser");
const tokenRegistry_1 = require("../tools/tokenRegistry");
const systemPrompt_1 = require("../prompts/systemPrompt");
// ─── ConversationEngine ───────────────────────────────────────────────────────
class ConversationEngine {
    parser;
    client;
    model;
    sessions = new Map();
    constructor(options = {}) {
        this.parser = new intentParser_1.IntentParser(options);
        this.client = new openai_1.default({
            apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
            baseURL: process.env.OPENAI_BASE_URL,
        });
        this.model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
    }
    /**
     * Create a new conversation session.
     */
    createSession(smartAccount, chainId = 8453) {
        const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.sessions.set(sessionId, {
            sessionId,
            state: 'IDLE',
            messages: [],
            smartAccount,
            chainId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        return sessionId;
    }
    /**
     * Get a session by ID.
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId) ?? null;
    }
    /**
     * Process a user message within a session.
     * Handles the full state machine: parse → clarify → confirm → execute.
     */
    async processMessage(sessionId, userMessage) {
        const session = this.sessions.get(sessionId);
        if (!session)
            throw new Error(`Session ${sessionId} not found`);
        session.updatedAt = Date.now();
        session.messages.push({ role: 'user', content: userMessage, timestamp: Date.now() });
        let agentResponse;
        let newState = session.state;
        try {
            switch (session.state) {
                case 'IDLE':
                case 'AWAITING_CLARIFICATION':
                    ({ agentResponse, newState } = await this.handleParsePhase(session, userMessage));
                    break;
                case 'AWAITING_CONFIRMATION':
                    ({ agentResponse, newState } = await this.handleConfirmationPhase(session, userMessage));
                    break;
                case 'CONFIRMED':
                case 'CANCELLED':
                    // Start fresh
                    session.state = 'IDLE';
                    session.currentParseResult = undefined;
                    session.currentIntent = undefined;
                    ({ agentResponse, newState } = await this.handleParsePhase(session, userMessage));
                    break;
                default:
                    agentResponse = 'Something went wrong. Please start over.';
                    newState = 'IDLE';
            }
        }
        catch (err) {
            console.error('[CONVERSATION] Error:', err.message);
            agentResponse = `Sorry, I encountered an error: ${err.message}. Please try again.`;
            newState = 'ERROR';
        }
        session.state = newState;
        session.messages.push({ role: 'assistant', content: agentResponse, timestamp: Date.now() });
        return {
            userMessage,
            agentResponse,
            state: newState,
            intent: session.currentIntent,
            parseResult: session.currentParseResult,
        };
    }
    // ─── Private: Parse Phase ──────────────────────────────────────────────────
    async handleParsePhase(session, userMessage) {
        // If we already have a parse result and user is amending it
        if (session.state === 'AWAITING_CLARIFICATION' && session.currentParseResult) {
            return this.handleAmendment(session, userMessage);
        }
        // Fresh parse
        const resolved = await this.parser.parseAndResolve(userMessage, session.smartAccount, session.chainId);
        session.currentParseResult = resolved.parseResult;
        // Case 1: Clarification needed
        if (resolved.parseResult.clarificationNeeded) {
            return {
                agentResponse: resolved.parseResult.clarificationQuestion ??
                    'Could you please provide more details about your transaction?',
                newState: 'AWAITING_CLARIFICATION',
            };
        }
        // Case 2: Resolve errors
        if (resolved.resolveErrors.length > 0) {
            return {
                agentResponse: resolved.resolveErrors.join('\n'),
                newState: 'AWAITING_CLARIFICATION',
            };
        }
        // Case 3: Intent resolved — ask for confirmation
        if (resolved.hief) {
            session.currentIntent = resolved.hief;
            const confirmMsg = await this.buildConfirmationMessage(resolved.hief, resolved.parseResult, session.chainId);
            return {
                agentResponse: confirmMsg,
                newState: 'AWAITING_CONFIRMATION',
            };
        }
        return {
            agentResponse: "I couldn't understand that DeFi instruction. Could you rephrase it?",
            newState: 'AWAITING_CLARIFICATION',
        };
    }
    // ─── Private: Amendment Phase ──────────────────────────────────────────────
    async handleAmendment(session, userMessage) {
        // Build context for the amendment
        const context = JSON.stringify(session.currentParseResult?.params ?? {});
        const completion = await this.client.chat.completions.create({
            model: this.model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: systemPrompt_1.AMENDMENT_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `Current intent params: ${context}\n\nUser amendment: "${userMessage}"`,
                },
            ],
        });
        let amendResult;
        try {
            amendResult = JSON.parse(completion.choices[0]?.message?.content ?? '{}');
        }
        catch {
            amendResult = { understood: false };
        }
        if (!amendResult.understood) {
            return {
                agentResponse: amendResult.clarificationQuestion ?? 'I didn\'t understand the change. What would you like to modify?',
                newState: 'AWAITING_CLARIFICATION',
            };
        }
        // Apply updates to current parse result
        if (session.currentParseResult && amendResult.updates) {
            session.currentParseResult.params = {
                ...session.currentParseResult.params,
                ...amendResult.updates,
            };
            session.currentParseResult.missingFields = [];
            session.currentParseResult.clarificationNeeded = false;
        }
        // Re-resolve with updated params
        const updatedMessage = this.buildUpdatedMessage(session.currentParseResult);
        const resolved = await this.parser.parseAndResolve(updatedMessage, session.smartAccount, session.chainId);
        if (resolved.hief) {
            session.currentIntent = resolved.hief;
            const confirmMsg = await this.buildConfirmationMessage(resolved.hief, resolved.parseResult, session.chainId);
            return { agentResponse: confirmMsg, newState: 'AWAITING_CONFIRMATION' };
        }
        return {
            agentResponse: resolved.resolveErrors.join('\n') || 'Could not resolve the updated intent.',
            newState: 'AWAITING_CLARIFICATION',
        };
    }
    // ─── Private: Confirmation Phase ──────────────────────────────────────────
    async handleConfirmationPhase(session, userMessage) {
        const msg = userMessage.trim().toLowerCase();
        // Detect confirmation
        const confirmWords = ['yes', 'y', 'confirm', 'ok', 'okay', 'sure', 'go', 'proceed',
            '确认', '是', '好', '确定', '执行', '对', '没错', '继续'];
        const cancelWords = ['no', 'n', 'cancel', 'stop', 'abort', 'nope',
            '取消', '不', '否', '算了', '不要', '停'];
        const modifyWords = ['change', 'modify', 'update', 'edit', 'different', 'instead',
            '修改', '改', '换', '不对', '不是'];
        if (confirmWords.some((w) => msg === w || msg.startsWith(w + ' '))) {
            return {
                agentResponse: this.buildExecutionMessage(session.currentIntent, session.chainId),
                newState: 'CONFIRMED',
            };
        }
        if (cancelWords.some((w) => msg === w || msg.startsWith(w + ' '))) {
            session.currentIntent = undefined;
            session.currentParseResult = undefined;
            return {
                agentResponse: '✅ Transaction cancelled. What else can I help you with?',
                newState: 'CANCELLED',
            };
        }
        if (modifyWords.some((w) => msg.includes(w))) {
            session.state = 'AWAITING_CLARIFICATION';
            return this.handleAmendment(session, userMessage);
        }
        // Ambiguous — re-ask
        return {
            agentResponse: 'Please reply **yes** to confirm or **no** to cancel. You can also describe changes you\'d like to make.',
            newState: 'AWAITING_CONFIRMATION',
        };
    }
    // ─── Private: Message builders ────────────────────────────────────────────
    async buildConfirmationMessage(intent, parseResult, chainId) {
        const uiHints = (intent.meta?.uiHints ?? {});
        const inputSymbol = uiHints.inputTokenSymbol ?? intent.input.token.slice(0, 8);
        const outputSymbol = uiHints.outputTokenSymbol ?? intent.outputs[0]?.token.slice(0, 8);
        const inputAmountHuman = uiHints.inputAmountHuman ?? intent.input.amount;
        const chain = (0, tokenRegistry_1.getChainName)(chainId);
        const slippage = ((intent.constraints.slippageBps ?? 50) / 100).toFixed(2);
        const deadline = new Date(intent.deadline * 1000).toLocaleTimeString();
        // Use template-based confirmation for fast response (single LLM call per intent)
        return this.buildFallbackConfirmation(intent, inputSymbol, outputSymbol, inputAmountHuman, slippage, chain);
    }
    buildFallbackConfirmation(intent, inputSymbol, outputSymbol, inputAmountHuman, slippage, chain) {
        const uiHints = (intent.meta?.uiHints ?? {});
        const protocol = uiHints.protocol ?? 'auto';
        const isDeposit = protocol === 'aave' || outputSymbol.startsWith('a');
        if (isDeposit) {
            return `📋 **Transaction Summary**

💰 Deposit **${inputAmountHuman} ${inputSymbol}** → **${outputSymbol}** (Aave v3)
🌐 Network: ${chain}
📈 Earn yield — no slippage, 1:1 ratio
🏦 Protocol: Aave v3 (lending & borrowing)

Reply **yes** to confirm or **no** to cancel.`;
        }
        return `📋 **Transaction Summary**

🔄 Swap **${inputAmountHuman} ${inputSymbol}** → **${outputSymbol}**
🌐 Network: ${chain}
📉 Max slippage: ${slippage}%
🤝 Protocol: Best available DEX (Odos / Uniswap V3)

Reply **yes** to confirm or **no** to cancel.`;
    }
    buildExecutionMessage(intent, chainId) {
        const uiHints2 = (intent.meta?.uiHints ?? {});
        const inputSymbol = uiHints2.inputTokenSymbol ?? 'tokens';
        const outputSymbol = uiHints2.outputTokenSymbol ?? 'tokens';
        const inputAmountHuman = uiHints2.inputAmountHuman ?? intent.input.amount;
        const protocol = uiHints2.protocol ?? 'auto';
        const isDeposit = protocol === 'aave' || outputSymbol.startsWith('a');
        if (isDeposit) {
            return `✅ **Intent confirmed!**

Your deposit intent has been submitted:
- **Intent ID**: \`${intent.intentId.slice(0, 16)}...\`
- **Action**: Deposit ${inputAmountHuman} ${inputSymbol} → ${outputSymbol} (Aave v3)
- **Status**: Preparing Aave supply transaction...

You'll receive a transaction to sign shortly.`;
        }
        return `✅ **Intent confirmed!**

Your intent has been created and submitted to the HIEF network:
- **Intent ID**: \`${intent.intentId.slice(0, 16)}...\`
- **Action**: Swap ${inputAmountHuman} ${inputSymbol} → ${outputSymbol}
- **Status**: Seeking best execution via DEX solvers...

Solvers are now competing to give you the best price. You'll receive a Safe transaction to sign shortly.`;
    }
    buildUpdatedMessage(parseResult) {
        const p = parseResult.params;
        const parts = [];
        if (p.inputAmount && p.inputToken)
            parts.push(`swap ${p.inputAmount} ${p.inputToken}`);
        if (p.outputToken)
            parts.push(`to ${p.outputToken}`);
        if (p.slippageBps)
            parts.push(`with ${p.slippageBps / 100}% slippage`);
        return parts.join(' ') || parseResult.rawIntent;
    }
}
exports.ConversationEngine = ConversationEngine;
//# sourceMappingURL=conversationEngine.js.map