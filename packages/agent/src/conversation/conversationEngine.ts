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
    const slippage = (intent.constraints.slippageBps / 100).toFixed(2);
    const deadline = new Date(intent.deadline * 1000).toLocaleTimeString();

    // Use LLM for natural language confirmation if available
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: CONFIRMATION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Original request: "${parseResult.rawIntent ?? intent.meta?.userIntentText}"
Transaction details:
- Action: ${parseResult.intentType}
- Sell: ${inputAmountHuman} ${inputSymbol}
- Buy: ${outputSymbol} (min: ${intent.outputs[0]?.minAmount === '0' ? 'market rate' : intent.outputs[0]?.minAmount})
- Slippage tolerance: ${slippage}%
- Network: ${chain}
- Deadline: ${deadline}
- Protocol: ${(intent.meta as any)?.protocol ?? 'best available (CoW Protocol)'}`,
          },
        ],
      });
      return completion.choices[0]?.message?.content ?? this.buildFallbackConfirmation(intent, inputSymbol, outputSymbol, inputAmountHuman, slippage, chain);
    } catch {
      return this.buildFallbackConfirmation(intent, inputSymbol, outputSymbol, inputAmountHuman, slippage, chain);
    }
  }

  private buildFallbackConfirmation(
    intent: HIEFIntent,
    inputSymbol: string,
    outputSymbol: string,
    inputAmountHuman: string,
    slippage: string,
    chain: string
  ): string {
    return `📋 **Transaction Summary**

🔄 Swap **${inputAmountHuman} ${inputSymbol}** → **${outputSymbol}**
🌐 Network: ${chain}
📉 Max slippage: ${slippage}%
🤝 Protocol: CoW Protocol (best price)

Reply **yes** to confirm or **no** to cancel.`;
  }

  private buildExecutionMessage(intent: HIEFIntent, chainId: number): string {
    const uiHints2 = (intent.meta?.uiHints ?? {}) as Record<string, string>;
    const inputSymbol = uiHints2.inputTokenSymbol ?? 'tokens';
    const outputSymbol = uiHints2.outputTokenSymbol ?? 'tokens';
    const inputAmountHuman = uiHints2.inputAmountHuman ?? intent.input.amount;

    return `✅ **Intent confirmed!**

Your intent has been created and submitted to the HIEF network:
- **Intent ID**: \`${intent.intentId.slice(0, 16)}...\`
- **Action**: Swap ${inputAmountHuman} ${inputSymbol} → ${outputSymbol}
- **Status**: Seeking best execution via CoW Protocol...

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
