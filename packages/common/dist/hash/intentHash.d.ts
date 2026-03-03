import type { HIEFIntent } from '../types';
/**
 * Compute the EIP-712 hash for a HIEFIntent.
 * This hash is the canonical identifier for the intent and must be
 * consistent across all implementations.
 */
export declare function computeIntentHash(intent: HIEFIntent): string;
/**
 * Verify the EIP-712 signature on a HIEFIntent.
 */
export declare function verifyIntentSignature(intent: HIEFIntent, intentHash: string): boolean;
//# sourceMappingURL=intentHash.d.ts.map