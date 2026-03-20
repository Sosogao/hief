import OpenAI from 'openai';
import { IntentParser, ParseResult, ResolvedIntent } from '../parser/intentParser';
import { resolveToken, formatAmount, getChainName } from '../tools/tokenRegistry';
import { CONFIRMATION_SYSTEM_PROMPT, AMENDMENT_SYSTEM_PROMPT } from '../prompts/systemPrompt';
import type { HIEFIntent } from '@hief/common';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConversationState =
  | 'IDLE'
  | 'AWAITING_CLARIFICATION'
  | 'AWAITING_CONFIRMATION'
  | 'CONFIRMED'
  | 'CANCELLED'
  | 'ERROR';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ConversationTurn {
  userMessage: string;
  agentResponse: string;
  state: ConversationState;
  intent?: HIEFIntent;
  parseResult?: ParseResult;
}

export interface ConversationSession {
  sessionId: string;
  state: ConversationState;
  messages: Message[];
  currentParseResult?: ParseResult;
  currentIntent?: HIEFIntent;
  smartAccount: string;
  chainId: number;
  createdAt: number;
  updatedAt: number;
}

// ─── ConversationEngine ───────────────────────────────────────────────────────

export class ConversationEngine {
  private parser: IntentParser;
  private client: OpenAI;
  private model: string;
  private sessions: Map<string, ConversationSession> = new Map();

  constructor(options: {
    apiKey?: string;
    model?: string;
    defaultChainId?: number;
  } = {}) {
    this.parser = new IntentParser(options);
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
    this.model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
  }

  /**
   * Create a new conversation session.
   */
  createSession(smartAccount: string, chainId: number = 8453): string {
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
  getSession(sessionId: string): ConversationSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Process a user message within a session.
   * Handles the full state machine: parse → clarify → confirm → execute.
   */
  async processMessage(sessionId: string, userMessage: string): Promise<ConversationTurn> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.updatedAt = Date.now();
    session.messages.push({ role: 'user', content: userMessage, timestamp: Date.now() });

    let agentResponse: string;
    let newState: ConversationState = session.state;

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
    } catch (err: any) {
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

  private async handleParsePhase(
    session: ConversationSession,
    userMessage: string
  ): Promise<{ agentResponse: string; newState: ConversationState }> {

    // If we already have a parse result and user is amending it
    if (session.state === 'AWAITING_CLARIFICATION' && session.currentParseResult) {
      return this.handleAmendment(session, userMessage);
    }

    // Fresh parse
    const resolved = await this.parser.parseAndResolve(
      userMessage,
      session.smartAccount,
      session.chainId
    );

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
      const confirmMsg = await this.buildConfirmationMessage(
        resolved.hief,
        resolved.parseResult,
        session.chainId
      );
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

  private async handleAmendment(
    session: ConversationSession,
    userMessage: string
  ): Promise<{ agentResponse: string; newState: ConversationState }> {
    // Build context for the amendment
    const context = JSON.stringify(session.currentParseResult?.params ?? {});

    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: AMENDMENT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Current intent params: ${context}\n\nUser amendment: "${userMessage}"`,
        },
      ],
    });

    let amendResult: any;
    try {
      amendResult = JSON.parse(completion.choices[0]?.message?.content ?? '{}');
    } catch {
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
    const updatedMessage = this.buildUpdatedMessage(session.currentParseResult!);
    const resolved = await this.parser.parseAndResolve(
      updatedMessage,
      session.smartAccount,
      session.chainId
    );

    if (resolved.hief) {
      session.currentIntent = resolved.hief;
      const confirmMsg = await this.buildConfirmationMessage(
        resolved.hief,
        resolved.parseResult,
        session.chainId
      );
      return { agentResponse: confirmMsg, newState: 'AWAITING_CONFIRMATION' };
    }

    return {
      agentResponse: resolved.resolveErrors.join('\n') || 'Could not resolve the updated intent.',
      newState: 'AWAITING_CLARIFICATION',
    };
  }

  // ─── Private: Confirmation Phase ──────────────────────────────────────────

  private async handleConfirmationPhase(
    session: ConversationSession,
    userMessage: string
  ): Promise<{ agentResponse: string; newState: ConversationState }> {
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
        agentResponse: this.buildExecutionMessage(session.currentIntent!, session.chainId),
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

  private async buildConfirmationMessage(
    intent: HIEFIntent,
    parseResult: ParseResult,
    chainId: number
  ): Promise<string> {
    const uiHints = (intent.meta?.uiHints ?? {}) as Record<string, string>;
    const inputSymbol = uiHints.inputTokenSymbol ?? intent.input.token.slice(0, 8);
    const outputSymbol = uiHints.outputTokenSymbol ?? intent.outputs[0]?.token.slice(0, 8);
    const inputAmountHuman = uiHints.inputAmountHuman ?? intent.input.amount;
    const chain = getChainName(chainId);
    const slippage = ((intent.constraints.slippageBps ?? 50) / 100).toFixed(2);
    const deadline = new Date(intent.deadline * 1000).toLocaleTimeString();

    // Use template-based confirmation for fast response (single LLM call per intent)
    return this.buildFallbackConfirmation(intent, inputSymbol, outputSymbol, inputAmountHuman, slippage, chain);
  }

  private buildFallbackConfirmation(
    intent: HIEFIntent,
    inputSymbol: string,
    outputSymbol: string,
    inputAmountHuman: string,
    slippage: string,
    chain: string
  ): string {
    const uiHints = (intent.meta?.uiHints ?? {}) as Record<string, unknown>;
    const protocol = (uiHints.protocol as string) ?? 'auto';
    const intentTag = (intent.meta?.tags?.[0] as string) || '';
    const leverageTag = intentTag;
    const isLeverage = protocol === 'fx' && (
      leverageTag === 'LEVERAGE_LONG' ||
      leverageTag === 'LEVERAGE_SHORT' ||
      leverageTag === 'LEVERAGE_CLOSE'
    );
    const leverageMult = uiHints.leverage ? `${uiHints.leverage}x ` : '';
    const leverageMarket = (uiHints.market as string) ?? '';
    const isFxSave   = !isLeverage && (protocol === 'fx' || outputSymbol === 'fxSAVE');
    const isAave     = !isFxSave && !isLeverage && (protocol === 'aave' || outputSymbol.startsWith('a'));
    const aaveAction = intentTag === 'WITHDRAW' ? 'Withdraw'
                     : intentTag === 'BORROW'   ? 'Borrow'
                     : intentTag === 'REPAY'    ? 'Repay'
                     : 'Deposit';
    const isLido     = protocol === 'lido' || outputSymbol === 'stETH';

    if (isLeverage) {
      const action = leverageTag === 'LEVERAGE_LONG' ? 'Long' : leverageTag === 'LEVERAGE_SHORT' ? 'Short' : 'Close';
      return `📋 **Transaction Summary**

⚡ ${leverageMult}${action} **${inputAmountHuman} ${inputSymbol}** (f(x) Protocol)
🌐 Network: ${chain}
🔄 Route: FxRoute (fork-compatible, on-chain only)
🏦 Protocol: f(x) Protocol — ${leverageMarket} market leveraged position

Reply **yes** to confirm or **no** to cancel.`;
    }

    if (isFxSave) {
      const action = outputSymbol === 'USDC' ? 'Withdraw' : 'Deposit';
      return `📋 **Transaction Summary**

💰 ${action} **${inputAmountHuman} ${inputSymbol}** → **${outputSymbol}** (f(x) Protocol)
🌐 Network: ${chain}
📈 Earn yield via fxSAVE — no slippage, 1:1 ratio
🏦 Protocol: f(x) Protocol (AladdinDAO)

Reply **yes** to confirm or **no** to cancel.`;
    }

    if (isAave) {
      const aaveDesc = aaveAction === 'Borrow'
        ? '💸 Borrow against your collateral — variable rate'
        : aaveAction === 'Repay'
        ? '✅ Repay borrowed position — reduces debt'
        : aaveAction === 'Withdraw'
        ? '💰 Withdraw supplied assets'
        : '📈 Earn yield — no slippage, 1:1 ratio';
      return `📋 **Transaction Summary**

💰 ${aaveAction} **${inputAmountHuman} ${inputSymbol}** → **${outputSymbol}** (Aave v3)
🌐 Network: ${chain}
${aaveDesc}
🏦 Protocol: Aave v3 (lending & borrowing)

Reply **yes** to confirm or **no** to cancel.`;
    }

    if (isLido) {
      return `📋 **Transaction Summary**

💰 Stake **${inputAmountHuman} ${inputSymbol}** → **${outputSymbol}** (Lido)
🌐 Network: ${chain}
📈 Earn ETH staking rewards — no slippage
🏦 Protocol: Lido (liquid staking)

Reply **yes** to confirm or **no** to cancel.`;
    }

    return `📋 **Transaction Summary**

🔄 Swap **${inputAmountHuman} ${inputSymbol}** → **${outputSymbol}**
🌐 Network: ${chain}
📉 Max slippage: ${slippage}%
🤝 Protocol: Best available DEX (Odos / Uniswap V3)

Reply **yes** to confirm or **no** to cancel.`;
  }

  private buildExecutionMessage(intent: HIEFIntent, chainId: number): string {
    const uiHints2 = (intent.meta?.uiHints ?? {}) as Record<string, unknown>;
    const inputSymbol = (uiHints2.inputTokenSymbol as string) ?? 'tokens';
    const outputSymbol = (uiHints2.outputTokenSymbol as string) ?? 'tokens';
    const inputAmountHuman = (uiHints2.inputAmountHuman as string) ?? intent.input.amount;
    const protocol = (uiHints2.protocol as string) ?? 'auto';
    const leverageTag2 = (intent.meta?.tags?.[0] as string) || '';
    const isLeverage2 = protocol === 'fx' && (
      leverageTag2 === 'LEVERAGE_LONG' ||
      leverageTag2 === 'LEVERAGE_SHORT' ||
      leverageTag2 === 'LEVERAGE_CLOSE'
    );
    const leverageMult2 = uiHints2.leverage ? `${uiHints2.leverage}x ` : '';
    const isFxSave2  = !isLeverage2 && (protocol === 'fx' || outputSymbol === 'fxSAVE');
    const intentTag2 = (intent.meta?.tags?.[0] as string) || '';
    const isAave2    = !isFxSave2 && !isLeverage2 && (protocol === 'aave' || outputSymbol.startsWith('a'));
    const aaveAction2 = intentTag2 === 'WITHDRAW' ? 'Withdraw'
                      : intentTag2 === 'BORROW'   ? 'Borrow'
                      : intentTag2 === 'REPAY'    ? 'Repay'
                      : 'Deposit';

    if (isLeverage2) {
      const action2 = leverageTag2 === 'LEVERAGE_LONG' ? 'Long' : leverageTag2 === 'LEVERAGE_SHORT' ? 'Short' : 'Close';
      return `✅ **Intent confirmed!**

Your leverage intent has been submitted:
- **Intent ID**: \`${intent.intentId.slice(0, 16)}...\`
- **Action**: ${leverageMult2}${action2} ${inputAmountHuman} ${inputSymbol} (f(x) Protocol)
- **Status**: Building position via FxRoute...

You'll receive a transaction to sign shortly.`;
    }

    if (isFxSave2) {
      const action = outputSymbol === 'USDC' ? 'Withdraw' : 'Deposit';
      return `✅ **Intent confirmed!**

Your intent has been submitted:
- **Intent ID**: \`${intent.intentId.slice(0, 16)}...\`
- **Action**: ${action} ${inputAmountHuman} ${inputSymbol} → ${outputSymbol} (f(x) Protocol)
- **Status**: Preparing fxSAVE transaction...

You'll receive a transaction to sign shortly.`;
    }

    if (isAave2) {
      const aaveStatus2 = aaveAction2 === 'Deposit' ? 'Preparing Aave supply transaction'
                        : aaveAction2 === 'Withdraw' ? 'Preparing Aave withdrawal'
                        : aaveAction2 === 'Borrow'   ? 'Preparing Aave borrow transaction'
                        : 'Preparing Aave repay transaction';
      return `✅ **Intent confirmed!**

Your ${aaveAction2.toLowerCase()} intent has been submitted:
- **Intent ID**: \`${intent.intentId.slice(0, 16)}...\`
- **Action**: ${aaveAction2} **${inputAmountHuman} ${inputSymbol}** → **${outputSymbol}** (Aave v3)
- **Status**: ${aaveStatus2}...

You'll receive a transaction to sign shortly.`;
    }

    return `✅ **Intent confirmed!**

Your intent has been created and submitted to the HIEF network:
- **Intent ID**: \`${intent.intentId.slice(0, 16)}...\`
- **Action**: Swap ${inputAmountHuman} ${inputSymbol} → ${outputSymbol}
- **Status**: Seeking best execution via DEX solvers...

Solvers are now competing to give you the best price. You'll receive a Safe transaction to sign shortly.`;
  }

  private buildUpdatedMessage(parseResult: ParseResult): string {
    const p = parseResult.params;
    const parts: string[] = [];
    if (p.inputAmount && p.inputToken) parts.push(`swap ${p.inputAmount} ${p.inputToken}`);
    if (p.outputToken) parts.push(`to ${p.outputToken}`);
    if (p.slippageBps) parts.push(`with ${p.slippageBps / 100}% slippage`);
    return parts.join(' ') || parseResult.rawIntent;
  }
}
