import type { HIEFIntent } from '@hief/common';
export type IntentType = 'SWAP' | 'DEPOSIT' | 'WITHDRAW' | 'BRIDGE' | 'PROVIDE_LIQUIDITY' | 'REMOVE_LIQUIDITY' | 'STAKE' | 'UNSTAKE' | 'UNKNOWN';
export interface ParsedIntentParams {
    inputToken: string | null;
    inputAmount: string | null;
    outputToken: string | null;
    minOutputAmount: string | null;
    slippageBps: number | null;
    deadline: number | null;
    targetChain: string | null;
    protocol: string | null;
    extraParams: Record<string, unknown>;
}
export interface ParseResult {
    intentType: IntentType;
    confidence: number;
    params: ParsedIntentParams;
    missingFields: string[];
    clarificationNeeded: boolean;
    clarificationQuestion: string | null;
    rawIntent: string;
}
export interface ResolvedIntent {
    parseResult: ParseResult;
    hief?: HIEFIntent;
    resolveErrors: string[];
}
export declare class IntentParser {
    private client;
    private model;
    private defaultChainId;
    constructor(options?: {
        apiKey?: string;
        model?: string;
        defaultChainId?: number;
    });
    /**
     * Parse a natural language DeFi instruction into structured parameters.
     */
    parse(userMessage: string): Promise<ParseResult>;
    /**
     * Parse AND resolve token addresses to produce a HIEFIntent.
     * Returns the parse result plus a fully formed HIEFIntent (if all params resolved).
     */
    parseAndResolve(userMessage: string, smartAccount: string, chainId?: number): Promise<ResolvedIntent>;
}
//# sourceMappingURL=intentParser.d.ts.map