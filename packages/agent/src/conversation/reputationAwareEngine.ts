/**
 * HIEF Reputation-Aware Conversation Engine
 *
 * Extends ConversationEngine with reputation context injection:
 *  - Fetches user reputation on session creation
 *  - Injects tier-specific system prompt suffix
 *  - Enriches confirmation messages with tier badge and risk warnings
 *  - Enforces tier-specific slippage defaults when user doesn't specify
 *
 * Usage:
 *   const engine = new ReputationAwareConversationEngine();
 *   const sessionId = await engine.createReputationSession('0xABC...', 8453);
 *   const turn = await engine.processMessage(sessionId, 'swap 100 USDC to ETH');
 */

import OpenAI from 'openai';
import { IntentParser, ParseResult } from '../parser/intentParser';
import { getChainName } from '../tools/tokenRegistry';
import { CONFIRMATION_SYSTEM_PROMPT, AMENDMENT_SYSTEM_PROMPT } from '../prompts/systemPrompt';
import {
  ReputationAgentAdapter,
  UserReputationContext,
  getReputationAgentAdapter,
} from '../reputation/reputationAgentAdapter';
import type { HIEFIntent } from '@hief/common';

// Re-export types from base engine
export type { ConversationState, Message, ConversationTurn } from './conversationEngine';
import type { ConversationState, Message, ConversationTurn, ConversationSession } from './conversationEngine';

// Extended session with reputation context
export interface ReputationSession extends ConversationSession {
  reputationContext?: UserReputationContext;
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class ReputationAwareConversationEngine {
  private parser: IntentParser;
  private client: OpenAI;
  private model: string;
  private sessions: Map<string, ReputationSession> = new Map();
  private repAdapter: ReputationAgentAdapter;

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
    this.repAdapter = getReputationAgentAdapter();
  }

  /**
   * Create a session and eagerly fetch reputation context.
   */
  async createReputationSession(smartAccount: string, chainId = 8453): Promise<string> {
    const sessionId = `rsess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Fetch reputation context (non-blocking fallback to UNKNOWN)
    const reputationContext = await this.repAdapter.getUserContext(smartAccount);

    this.sessions.set(sessionId, {
      sessionId,
      state: 'IDLE',
      messages: [],
      smartAccount,
      chainId,
      reputationContext,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return sessionId;
  }

  getSession(sessionId: string): ReputationSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Process a user message with reputation-aware context.
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
      console.error('[REP-ENGINE] Error:', err.message);
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

  // ── Parse Phase ───────────────────────────────────────────────────────────────

  private async handleParsePhase(
    session: ReputationSession,
    userMessage: string
  ): Promise<{ agentResponse: string; newState: ConversationState }> {

    if (session.state === 'AWAITING_CLARIFICATION' && session.currentParseResult) {
      return this.handleAmendment(session, userMessage);
    }

    const resolved = await this.parser.parseAndResolve(
      userMessage,
      session.smartAccount,
      session.chainId
    );

    session.currentParseResult = resolved.parseResult;

    // Apply tier-specific slippage default if not specified by user
    const ctx = session.reputationContext;
    if (ctx && resolved.parseResult.params && !resolved.parseResult.params.slippageBps) {
      // Default slippage: half of tier max, capped at reasonable defaults
      const defaultSlippage = Math.min(ctx.maxSlippageBps / 2, 50); // max 0.5% default
      resolved.parseResult.params.slippageBps = defaultSlippage;
    }

    if (resolved.parseResult.clarificationNeeded) {
      return {
        agentResponse: resolved.parseResult.clarificationQuestion ??
          'Could you please provide more details?',
        newState: 'AWAITING_CLARIFICATION',
      };
    }

    if (resolved.resolveErrors.length > 0) {
      return {
        agentResponse: resolved.resolveErrors.join('\n'),
        newState: 'AWAITING_CLARIFICATION',
      };
    }

    if (resolved.hief) {
      session.currentIntent = resolved.hief;
      const confirmMsg = await this.buildConfirmationMessage(
        resolved.hief,
        resolved.parseResult,
        session.chainId,
        session.reputationContext
      );
      return { agentResponse: confirmMsg, newState: 'AWAITING_CONFIRMATION' };
    }

    return {
      agentResponse: "I couldn't understand that DeFi instruction. Could you rephrase it?",
      newState: 'AWAITING_CLARIFICATION',
    };
  }

  // ── Amendment Phase ───────────────────────────────────────────────────────────

  private async handleAmendment(
    session: ReputationSession,
    userMessage: string
  ): Promise<{ agentResponse: string; newState: ConversationState }> {
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

    if (session.currentParseResult && amendResult.updates) {
      session.currentParseResult.params = {
        ...session.currentParseResult.params,
        ...amendResult.updates,
      };
      session.currentParseResult.missingFields = [];
      session.currentParseResult.clarificationNeeded = false;
    }

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
        session.chainId,
        session.reputationContext
      );
      return { agentResponse: confirmMsg, newState: 'AWAITING_CONFIRMATION' };
    }

    return {
      agentResponse: resolved.resolveErrors.join('\n') || 'Could not resolve the updated intent.',
      newState: 'AWAITING_CLARIFICATION',
    };
  }

  // ── Confirmation Phase ────────────────────────────────────────────────────────

  private async handleConfirmationPhase(
    session: ReputationSession,
    userMessage: string
  ): Promise<{ agentResponse: string; newState: ConversationState }> {
    const msg = userMessage.trim().toLowerCase();

    const confirmWords = ['yes', 'y', 'confirm', 'ok', 'okay', 'sure', 'go', 'proceed',
      '确认', '是', '好', '确定', '执行', '对', '没错', '继续'];
    const cancelWords = ['no', 'n', 'cancel', 'stop', 'abort', 'nope',
      '取消', '不', '否', '算了', '不要', '停'];
    const modifyWords = ['change', 'modify', 'update', 'edit', 'different', 'instead',
      '修改', '改', '换', '不对', '不是'];

    if (confirmWords.some((w) => msg === w || msg.startsWith(w + ' '))) {
      return {
        agentResponse: this.buildExecutionMessage(session.currentIntent!, session.reputationContext),
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

    return {
      agentResponse: 'Please reply **yes** to confirm or **no** to cancel.',
      newState: 'AWAITING_CONFIRMATION',
    };
  }

  // ── Message builders ──────────────────────────────────────────────────────────

  private async buildConfirmationMessage(
    intent: HIEFIntent,
    parseResult: ParseResult,
    chainId: number,
    ctx?: UserReputationContext
  ): Promise<string> {
    const uiHints = (intent.meta?.uiHints ?? {}) as Record<string, string>;
    const inputSymbol = uiHints.inputTokenSymbol ?? intent.input.token.slice(0, 8);
    const outputSymbol = uiHints.outputTokenSymbol ?? intent.outputs[0]?.token.slice(0, 8);
    const inputAmountHuman = uiHints.inputAmountHuman ?? intent.input.amount;
    const chain = getChainName(chainId);
    const slippage = ((intent.constraints.slippageBps ?? 50) / 100).toFixed(2);

    // Build reputation-aware system prompt
    const repSuffix = ctx ? this.repAdapter.buildSystemPromptSuffix(ctx) : '';
    const systemPrompt = CONFIRMATION_SYSTEM_PROMPT + repSuffix;

    // Build reputation header for confirmation
    const repHeader = ctx ? `\n${this.repAdapter.buildConfirmationHeader(ctx)}\n` : '';

    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Original request: "${parseResult.rawIntent ?? intent.meta?.userIntentText}"
Transaction details:
- Action: ${parseResult.intentType}
- Sell: ${inputAmountHuman} ${inputSymbol}
- Buy: ${outputSymbol}
- Slippage tolerance: ${slippage}%
- Network: ${chain}
- User tier: ${ctx?.tier ?? 'UNKNOWN'} (score: ${ctx?.score ?? 0})
- Daily limit: $${ctx?.dailyLimitUsd?.toLocaleString() ?? '500'}
${repHeader}`,
          },
        ],
      });
      return completion.choices[0]?.message?.content ?? this.buildFallbackConfirmation(
        intent, inputSymbol, outputSymbol, inputAmountHuman, slippage, chain, ctx
      );
    } catch {
      return this.buildFallbackConfirmation(
        intent, inputSymbol, outputSymbol, inputAmountHuman, slippage, chain, ctx
      );
    }
  }

  private buildFallbackConfirmation(
    intent: HIEFIntent,
    inputSymbol: string,
    outputSymbol: string,
    inputAmountHuman: string,
    slippage: string,
    chain: string,
    ctx?: UserReputationContext
  ): string {
    const tierLine = ctx ? `\n${ctx.tierBadge} | Score: ${ctx.score} | Daily limit: $${ctx.dailyLimitUsd.toLocaleString()}` : '';
    const warnings = ctx?.riskWarnings.map((w) => `\n⚠️ ${w}`).join('') ?? '';

    return `📋 **Transaction Summary**
${tierLine}${warnings}

🔄 Swap **${inputAmountHuman} ${inputSymbol}** → **${outputSymbol}**
🌐 Network: ${chain}
📉 Max slippage: ${slippage}%
🤝 Protocol: CoW Protocol (best price)

Reply **yes** to confirm or **no** to cancel.`;
  }

  private buildExecutionMessage(intent: HIEFIntent, ctx?: UserReputationContext): string {
    const uiHints = (intent.meta?.uiHints ?? {}) as Record<string, string>;
    const inputSymbol = uiHints.inputTokenSymbol ?? 'tokens';
    const outputSymbol = uiHints.outputTokenSymbol ?? 'tokens';
    const inputAmountHuman = uiHints.inputAmountHuman ?? intent.input.amount;
    const tierLine = ctx ? `\n${ctx.tierBadge} | Score: ${ctx.score}` : '';

    return `✅ **Intent confirmed!**
${tierLine}

Your intent has been submitted to the HIEF network:
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
