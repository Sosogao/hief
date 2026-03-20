/**
 * ERC-7683 Cross-Chain Intent Adapter
 *
 * Converts between HIEFIntent (superset) and ERC-7683 CrossChainOrder.
 * Single-chain HIEFIntents are passed through unchanged (destChainId absent).
 *
 * ERC-7683 spec: https://eips.ethereum.org/EIPS/eip-7683
 */

import type { HIEFIntent, Address, HexString, FillInstruction } from '../types';

// ─── ERC-7683 types ───────────────────────────────────────────────────────────

export interface ERC7683Input {
  token: string;   // bytes32 (padded address)
  amount: bigint;
}

export interface ERC7683Output {
  token: string;   // bytes32
  amount: bigint;
  recipient: string; // bytes32 (padded address)
  chainId: number;
}

export interface CrossChainOrder {
  settlementContract: Address;
  swapper: Address;
  nonce: bigint;
  originChainId: number;
  initiateDeadline: number;
  fillDeadline: number;
  orderData: HexString; // ABI-encoded HIEF-specific extensions
}

export interface ResolvedCrossChainOrder {
  settlementContract: Address;
  swapper: Address;
  nonce: bigint;
  originChainId: number;
  fillDeadline: number;
  maxSpent: ERC7683Input[];
  minReceived: ERC7683Output[];
  fillInstructions: FillInstruction[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Pad a 20-byte address to 32-byte bytes32 (right-zero-padded in low 20 bytes). */
function addressToBytes32(addr: Address): string {
  return '0x' + '000000000000000000000000' + addr.replace('0x', '').toLowerCase();
}

/** Convert bytes32 back to address (last 20 bytes). */
function bytes32ToAddress(b32: string): Address {
  return '0x' + b32.replace('0x', '').slice(-40);
}

// ─── toERC7683 ───────────────────────────────────────────────────────────────

/**
 * Convert a HIEFIntent to an ERC-7683 CrossChainOrder.
 * For single-chain intents, destChainId defaults to chainId (same-chain fill).
 */
export function toERC7683(intent: HIEFIntent): CrossChainOrder {
  const settlementContract = intent.settlementContract
    ?? '0x0000000000000000000000000000000000000000'; // placeholder until contract deployed

  return {
    settlementContract,
    swapper: intent.smartAccount,
    nonce: BigInt(intent.intentId),
    originChainId: intent.chainId,
    initiateDeadline: intent.deadline,
    fillDeadline: intent.deadline,
    // Encode HIEF-specific extensions in orderData as a JSON hex string
    // Full ABI-encoding deferred until settlement contract ABI is finalised
    orderData: '0x' + Buffer.from(JSON.stringify({
      intentId:   intent.intentId,
      input:      intent.input,
      outputs:    intent.outputs,
      constraints: intent.constraints,
      priorityFee: intent.priorityFee,
      policyRef:  intent.policyRef,
      destChainId: intent.destChainId ?? intent.chainId,
    })).toString('hex'),
  };
}

/**
 * Convert a HIEFIntent to a ResolvedCrossChainOrder (with resolved token amounts).
 */
export function toResolvedCrossChainOrder(intent: HIEFIntent): ResolvedCrossChainOrder {
  const destChainId = intent.destChainId ?? intent.chainId;

  const maxSpent: ERC7683Input[] = [{
    token:  addressToBytes32(intent.input.token),
    amount: BigInt(intent.input.amount),
  }];

  const minReceived: ERC7683Output[] = intent.outputs.map((o) => ({
    token:     addressToBytes32(o.token),
    amount:    BigInt(o.minAmount),
    recipient: addressToBytes32(o.recipient ?? intent.smartAccount),
    chainId:   destChainId,
  }));

  return {
    settlementContract: intent.settlementContract
      ?? '0x0000000000000000000000000000000000000000',
    swapper:        intent.smartAccount,
    nonce:          BigInt(intent.intentId),
    originChainId:  intent.chainId,
    fillDeadline:   intent.deadline,
    maxSpent,
    minReceived,
    fillInstructions: intent.fillInstructions ?? [],
  };
}

// ─── fromERC7683 ─────────────────────────────────────────────────────────────

/**
 * Reconstruct a partial HIEFIntent from an ERC-7683 CrossChainOrder.
 * The HIEF-specific fields (policyRef, priorityFee, signature) must be
 * supplied separately — they are not part of the ERC-7683 standard.
 */
export function fromERC7683(
  order: CrossChainOrder,
  overrides: Partial<HIEFIntent> = {},
): Partial<HIEFIntent> {
  let extensions: Record<string, unknown> = {};
  try {
    extensions = JSON.parse(Buffer.from(order.orderData.replace('0x', ''), 'hex').toString('utf8'));
  } catch {
    // orderData is not HIEF-encoded — ignore
  }

  return {
    intentVersion: '0.1',
    intentId:     extensions.intentId as string ?? ('0x' + order.nonce.toString(16).padStart(64, '0')),
    smartAccount: order.swapper,
    chainId:      order.originChainId,
    deadline:     order.fillDeadline,
    input:        (extensions.input as HIEFIntent['input']) ?? { token: '0x', amount: '0' },
    outputs:      (extensions.outputs as HIEFIntent['outputs']) ?? [],
    constraints:  (extensions.constraints as HIEFIntent['constraints']) ?? {},
    settlementContract: order.settlementContract,
    destChainId:  extensions.destChainId as number ?? order.originChainId,
    ...overrides,
  };
}
