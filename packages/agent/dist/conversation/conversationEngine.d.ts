import { ParseResult } from '../parser/intentParser';
import type { HIEFIntent } from '@hief/common';
export type ConversationState = 'IDLE' | 'AWAITING_CLARIFICATION' | 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'CANCELLED' | 'ERROR';
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
export declare class ConversationEngine {
    private parser;
    private client;
    private model;
    private sessions;
    constructor(options?: {
        apiKey?: string;
        model?: string;
        defaultChainId?: number;
    });
    /**
     * Create a new conversation session.
     */
    createSession(smartAccount: string, chainId?: number): string;
    /**
     * Get a session by ID.
     */
    getSession(sessionId: string): ConversationSession | null;
    /**
     * Process a user message within a session.
     * Handles the full state machine: parse → clarify → confirm → execute.
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
//# sourceMappingURL=conversationEngine.d.ts.map