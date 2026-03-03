/**
 * Token Registry
 *
 * Maps human-readable token symbols and aliases to on-chain addresses.
 * Supports multi-chain (Base, Ethereum mainnet).
 */
export interface TokenInfo {
    symbol: string;
    name: string;
    address: string;
    decimals: number;
    chainId: number;
    aliases: string[];
}
declare const BASE_TOKENS: TokenInfo[];
declare const MAINNET_TOKENS: TokenInfo[];
/**
 * Resolve a token symbol/alias to its TokenInfo for a given chain.
 */
export declare function resolveToken(symbolOrAlias: string, chainId: number): TokenInfo | null;
/**
 * Format a human-readable amount to on-chain units (BigInt string).
 */
export declare function parseAmount(amount: string | number, decimals: number): string;
/**
 * Format on-chain units back to human-readable string.
 */
export declare function formatAmount(rawAmount: string, decimals: number): string;
/**
 * Get default chain name.
 */
export declare function getChainName(chainId: number): string;
export { BASE_TOKENS, MAINNET_TOKENS };
//# sourceMappingURL=tokenRegistry.d.ts.map