import type { HIEFIntent, HIEFSolution } from '@hief/common';
export interface CowQuote {
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    buyAmount: string;
    feeAmount: string;
    validTo: number;
    appData: string;
    kind: 'sell' | 'buy';
    partiallyFillable: boolean;
    quoteId?: number;
}
export interface CowOrderData {
    sellToken: string;
    buyToken: string;
    receiver: string;
    sellAmount: string;
    buyAmount: string;
    validTo: number;
    appData: string;
    feeAmount: string;
    kind: 'sell' | 'buy';
    partiallyFillable: boolean;
    sellTokenBalance: 'erc20' | 'external' | 'internal';
    buyTokenBalance: 'erc20' | 'internal';
}
/**
 * Get a quote from CoW Protocol for the given intent.
 */
export declare function getCowQuote(intent: HIEFIntent): Promise<CowQuote | null>;
/**
 * Build a HIEF Solution from a CoW Protocol quote.
 * The execution plan includes the approve + settlement calls.
 */
export declare function buildSolutionFromCowQuote(intent: HIEFIntent, quote: CowQuote, solverId: string): HIEFSolution;
/**
 * Submit a CoW order after Safe execution.
 * Returns the order UID.
 */
export declare function submitCowOrder(intent: HIEFIntent, orderData: CowOrderData, signature: string): Promise<string | null>;
//# sourceMappingURL=cowAdapter.d.ts.map