import OpenAI from 'openai';
import { z } from 'zod';
import { resolveToken, parseAmount } from '../tools/tokenRegistry';
import { INTENT_EXTRACTION_SYSTEM_PROMPT } from '../prompts/systemPrompt';
import type { HIEFIntent } from '@hief/common';
import { ethers } from 'ethers';

// ─── Types ────────────────────────────────────────────────────────────────────

export type IntentType =
  | 'SWAP'
  | 'DEPOSIT'
  | 'WITHDRAW'
  | 'BRIDGE'
  | 'PROVIDE_LIQUIDITY'
  | 'REMOVE_LIQUIDITY'
  | 'STAKE'
  | 'UNSTAKE'
  | 'UNKNOWN';

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

// ─── Zod schema for LLM output validation ─────────────────────────────────────

const ParseResultSchema = z.object({
  intentType: z.enum([
    'SWAP', 'DEPOSIT', 'WITHDRAW',
    'BRIDGE', 'PROVIDE_LIQUIDITY', 'REMOVE_LIQUIDITY',
    'STAKE', 'UNSTAKE', 'UNKNOWN',
  ]),
  confidence: z.number().min(0).max(1),
  params: z.object({
    inputToken: z.string().nullable(),
    inputAmount: z.string().nullable(),
    outputToken: z.string().nullable(),
    minOutputAmount: z.string().nullable(),
    slippageBps: z.number().nullable(),
    deadline: z.number().nullable(),
    targetChain: z.string().nullable(),
    protocol: z.string().nullable(),
    extraParams: z.record(z.unknown()).default({}),
  }),
  missingFields: z.array(z.string()),
  clarificationNeeded: z.boolean(),
  clarificationQuestion: z.string().nullable(),
  rawIntent: z.string(),
});

// ─── IntentParser class ───────────────────────────────────────────────────────

export class IntentParser {
  private client: OpenAI;
  private model: string;
  private defaultChainId: number;

  constructor(options: {
    apiKey?: string;
    model?: string;
    defaultChainId?: number;
  } = {}) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
    this.model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
    this.defaultChainId = options.defaultChainId ?? 8453; // Base
  }

  /**
   * Parse a natural language DeFi instruction into structured parameters.
   */
  async parse(userMessage: string): Promise<ParseResult> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: INTENT_EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error('LLM returned empty response');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
    }

    const validated = ParseResultSchema.safeParse(parsed);
    if (!validated.success) {
      console.warn('[PARSER] Schema validation warning:', validated.error.issues);
      // Attempt lenient parse
      return parsed as ParseResult;
    }

    return validated.data as ParseResult;
  }

  /**
   * Parse AND resolve token addresses to produce a HIEFIntent.
   * Returns the parse result plus a fully formed HIEFIntent (if all params resolved).
   */
  async parseAndResolve(
    userMessage: string,
    smartAccount: string,
    chainId?: number
  ): Promise<ResolvedIntent> {
    const chain = chainId ?? this.defaultChainId;
    const parseResult = await this.parse(userMessage);
    const resolveErrors: string[] = [];

    // If clarification is needed, return early
    if (parseResult.clarificationNeeded || parseResult.intentType === 'UNKNOWN') {
      return { parseResult, resolveErrors };
    }

    // Supported intent types
    const SUPPORTED_TYPES = new Set(['SWAP', 'DEPOSIT', 'WITHDRAW', 'STAKE', 'UNSTAKE']);
    if (!SUPPORTED_TYPES.has(parseResult.intentType)) {
      resolveErrors.push(`Intent type "${parseResult.intentType}" is not yet supported. Supported: SWAP, DEPOSIT, WITHDRAW (Aave), STAKE, UNSTAKE (Lido).`);
      return { parseResult, resolveErrors };
    }

    const { params } = parseResult;

    // Resolve input token
    if (!params.inputToken) {
      resolveErrors.push('Input token is required');
      return { parseResult, resolveErrors };
    }
    const inputTokenInfo = resolveToken(params.inputToken, chain);
    if (!inputTokenInfo) {
      resolveErrors.push(`Unknown token: "${params.inputToken}" on chain ${chain}`);
      return { parseResult, resolveErrors };
    }

    // Resolve output token
    // DEPOSIT:  output is the receipt token (aToken) — placeholder, solver fills real address
    // WITHDRAW: output is the underlying asset (same as input) — user gets their token back
    // STAKE:    output is the staking receipt token (e.g. stETH) — solver fills real address
    // UNSTAKE:  output is the underlying asset (ETH for Lido)
    // SWAP:     output is the specified target token
    const isDeposit  = parseResult.intentType === 'DEPOSIT';
    const isWithdraw = parseResult.intentType === 'WITHDRAW';
    const isStake    = parseResult.intentType === 'STAKE';
    const isUnstake  = parseResult.intentType === 'UNSTAKE';
    const isSkill    = isDeposit || isWithdraw || isStake || isUnstake;

    let outputTokenAddress = '0x0000000000000000000000000000000000000000'; // filled by solver
    const protocolHint = params.protocol?.toLowerCase();
    let outputTokenSymbol  = isDeposit ? (
                               protocolHint === 'fx' || protocolHint === 'fxsave' ? 'fxSAVE' :
                               `a${inputTokenInfo.symbol}`
                             )
                           : isStake   ? `st${inputTokenInfo.symbol}`
                           : '';

    if (isWithdraw || isUnstake) {
      // For WITHDRAW/UNSTAKE the user receives the underlying asset back
      outputTokenAddress = inputTokenInfo.address;
      outputTokenSymbol  = inputTokenInfo.symbol;
    } else if (!isSkill) {
      if (!params.outputToken) {
        resolveErrors.push('Output token is required');
        return { parseResult, resolveErrors };
      }
      const outputTokenInfo = resolveToken(params.outputToken, chain);
      if (!outputTokenInfo) {
        resolveErrors.push(`Unknown token: "${params.outputToken}" on chain ${chain}`);
        return { parseResult, resolveErrors };
      }
      outputTokenAddress = outputTokenInfo.address;
      outputTokenSymbol  = outputTokenInfo.symbol;
    } else if (params.outputToken) {
      // DEPOSIT/STAKE: user may specify the receipt token (e.g. "aUSDC", "stETH") — try to resolve
      const outputTokenInfo = resolveToken(params.outputToken, chain);
      if (outputTokenInfo) {
        outputTokenAddress = outputTokenInfo.address;
        outputTokenSymbol  = outputTokenInfo.symbol;
      }
    }

    // Resolve amount
    if (!params.inputAmount) {
      resolveErrors.push('Input amount is required');
      return { parseResult, resolveErrors };
    }

    let rawInputAmount: string;
    if (params.inputAmount === 'ALL') {
      // Placeholder — in production, query on-chain balance
      resolveErrors.push('Amount "ALL" requires on-chain balance query. Please specify an exact amount.');
      return { parseResult, resolveErrors };
    }

    try {
      rawInputAmount = parseAmount(params.inputAmount, inputTokenInfo.decimals);
    } catch (err: any) {
      resolveErrors.push(`Invalid amount: ${err.message}`);
      return { parseResult, resolveErrors };
    }

    // Compute deadline
    const deadlineSeconds = params.deadline ?? 3600;
    const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;

    // Compute slippage
    const slippageBps = params.slippageBps ?? 50;

    // Compute minimum output — DEPOSIT/WITHDRAW/STAKE/UNSTAKE are 1:1 so min = input amount
    let minOutputRaw = '0';
    if (isSkill) {
      minOutputRaw = rawInputAmount;   // expect at least the same amount back (1:1 for lending/staking)
    } else if (params.minOutputAmount) {
      try {
        minOutputRaw = parseAmount(params.minOutputAmount, inputTokenInfo.decimals);
      } catch {
        // Non-fatal: use 0 as min
      }
    }

    // Build HIEFIntent
    const intentId = ethers.hexlify(ethers.randomBytes(32));
    const hief: HIEFIntent = {
      intentVersion: '0.1',
      intentId,
      smartAccount,
      chainId: chain,
      deadline,
      input: {
        token: inputTokenInfo.address,
        amount: rawInputAmount,
      },
      outputs: [
        {
          token: outputTokenAddress,
          minAmount: minOutputRaw,
        },
      ],
      constraints: {
        slippageBps: isSkill ? 0 : slippageBps,  // lending/staking is 1:1, no slippage
      },
      priorityFee: { token: 'HIEF', amount: '0' },
      policyRef: { policyVersion: 'v0.1' },
      signature: {
        type: 'EIP712_EOA',
        signer: smartAccount,
        sig: '0x', // Will be signed by user
      },
      meta: {
        userIntentText: userMessage,
        tags: [parseResult.intentType, inputTokenInfo.symbol, outputTokenSymbol],
        uiHints: {
          inputTokenSymbol: inputTokenInfo.symbol,
          outputTokenSymbol,
          inputAmountHuman: params.inputAmount,
          protocol: params.protocol ?? (isStake || isUnstake ? 'lido' : isDeposit || isWithdraw ? 'aave' : 'auto'),
          // Note: 'aave' is the default protocol for DEPOSIT/WITHDRAW when none specified
        },
      },
    };

    return { parseResult, hief, resolveErrors };
  }
}
