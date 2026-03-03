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
import { UserReputationContext } from '../reputation/reputationAgentAdapter';
export type { ConversationState, Message, ConversationTurn } from './conversationEngine';
import type { ConversationTurn, ConversationSession } from './conversationEngine';
export interface ReputationSession extends ConversationSession {
    reputationContext?: UserReputationContext;
}
export declare class ReputationAwareConversationEngine {
    private parser;
    private client;
    private model;
    private sessions;
    private repAdapter;
    constructor(options?: {
        apiKey?: string;
        model?: string;
        defaultChainId?: number;
    });
    /**
     * Create a session and eagerly fetch reputation context.
     */
    createReputationSession(smartAccount: string, chainId?: number): Promise<string>;
    getSession(sessionId: string): ReputationSession | null;
    /**
     * Process a user message with reputation-aware context.
     */
    processMessage(sessionId: string, userMessage: string): Promise<ConversationTurn>;
    private handleParsePhase;
    private handleAmendment;
    private handleConfirmationPhase;
    private buildConfirmationMessage;
    private buildFallbackConfirmation;
    private buildExecutionMessage;
    private buildUpdatedMessage;
}
//# sourceMappingURL=reputationAwareEngine.d.ts.map