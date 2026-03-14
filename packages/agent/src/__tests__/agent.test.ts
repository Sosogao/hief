/**
 * @hief/agent Unit Tests
 *
 * Tests the Intent Parser and Conversation Engine using mocked LLM responses.
 * No real API key required.
 */

import { resolveToken, parseAmount, formatAmount, getChainName } from '../tools/tokenRegistry';
import { IntentParser, ParseResult } from '../parser/intentParser';
import { ConversationEngine } from '../conversation/conversationEngine';

// ─── Mock OpenAI ──────────────────────────────────────────────────────────────

jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn(),
        },
      },
    })),
  };
});

const MOCK_SMART_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const BASE_CHAIN_ID = 8453;

// ─── Token Registry Tests ──────────────────────────────────────────────────────

describe('TokenRegistry', () => {
  test('resolves USDC on Base by symbol', () => {
    const token = resolveToken('USDC', BASE_CHAIN_ID);
    expect(token).not.toBeNull();
    expect(token!.symbol).toBe('USDC');
    expect(token!.decimals).toBe(6);
    expect(token!.address).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });

  test('resolves ETH on Base by alias "以太"', () => {
    const token = resolveToken('以太', BASE_CHAIN_ID);
    expect(token).not.toBeNull();
    expect(token!.symbol).toBe('ETH');
  });

  test('resolves USDC by alias "u"', () => {
    const token = resolveToken('u', BASE_CHAIN_ID);
    expect(token).not.toBeNull();
    expect(token!.symbol).toBe('USDC');
  });

  test('resolves BTC alias "比特币" to cbBTC on Base', () => {
    const token = resolveToken('比特币', BASE_CHAIN_ID);
    expect(token).not.toBeNull();
    expect(token!.symbol).toBe('cbBTC');
  });

  test('resolves token by direct address', () => {
    const token = resolveToken('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', BASE_CHAIN_ID);
    expect(token).not.toBeNull();
    expect(token!.symbol).toBe('USDC');
  });

  test('returns null for unknown token', () => {
    const token = resolveToken('UNKNOWN_XYZ', BASE_CHAIN_ID);
    expect(token).toBeNull();
  });

  test('parseAmount converts 100 USDC correctly (6 decimals)', () => {
    const raw = parseAmount('100', 6);
    expect(raw).toBe('100000000');
  });

  test('parseAmount converts 0.5 ETH correctly (18 decimals)', () => {
    const raw = parseAmount('0.5', 18);
    expect(raw).toBe('500000000000000000');
  });

  test('formatAmount converts raw USDC back to human', () => {
    const human = formatAmount('100000000', 6);
    expect(human).toBe('100');
  });

  test('getChainName returns correct names', () => {
    expect(getChainName(8453)).toBe('Base');
    expect(getChainName(1)).toBe('Ethereum');
    expect(getChainName(84532)).toBe('Base Sepolia');
  });
});

// ─── IntentParser Tests ────────────────────────────────────────────────────────

describe('IntentParser', () => {
  let parser: IntentParser;
  let mockCreate: jest.Mock;

  beforeEach(() => {
    const OpenAI = require('openai').default;
    parser = new IntentParser({ apiKey: 'test-key' });
    mockCreate = (parser as any).client.chat.completions.create;
  });

  function mockLLMResponse(result: Partial<ParseResult>) {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(result) } }],
    });
  }

  test('parses "swap 100 USDC to ETH" correctly', async () => {
    mockLLMResponse({
      intentType: 'SWAP',
      confidence: 0.98,
      params: {
        inputToken: 'USDC',
        inputAmount: '100',
        outputToken: 'ETH',
        minOutputAmount: null,
        slippageBps: null,
        deadline: null,
        targetChain: null,
        protocol: null,
        extraParams: {},
      },
      missingFields: [],
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawIntent: 'swap 100 USDC to ETH',
    });

    const result = await parser.parse('swap 100 USDC to ETH');
    expect(result.intentType).toBe('SWAP');
    expect(result.params.inputToken).toBe('USDC');
    expect(result.params.inputAmount).toBe('100');
    expect(result.params.outputToken).toBe('ETH');
    expect(result.clarificationNeeded).toBe(false);
  });

  test('requests clarification when amount is missing', async () => {
    mockLLMResponse({
      intentType: 'SWAP',
      confidence: 0.85,
      params: {
        inputToken: 'ETH',
        inputAmount: null,
        outputToken: 'USDC',
        minOutputAmount: null,
        slippageBps: null,
        deadline: null,
        targetChain: null,
        protocol: null,
        extraParams: {},
      },
      missingFields: ['inputAmount'],
      clarificationNeeded: true,
      clarificationQuestion: '您想换多少 ETH？',
      rawIntent: '帮我把以太换成USDC',
    });

    const result = await parser.parse('帮我把以太换成USDC');
    expect(result.clarificationNeeded).toBe(true);
    expect(result.clarificationQuestion).toBe('您想换多少 ETH？');
    expect(result.missingFields).toContain('inputAmount');
  });

  test('parseAndResolve builds valid HIEFIntent for SWAP', async () => {
    mockLLMResponse({
      intentType: 'SWAP',
      confidence: 0.99,
      params: {
        inputToken: 'USDC',
        inputAmount: '100',
        outputToken: 'ETH',
        minOutputAmount: null,
        slippageBps: 50,
        deadline: 3600,
        targetChain: null,
        protocol: null,
        extraParams: {},
      },
      missingFields: [],
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawIntent: 'swap 100 USDC to ETH',
    });

    const resolved = await parser.parseAndResolve(
      'swap 100 USDC to ETH',
      MOCK_SMART_ACCOUNT,
      BASE_CHAIN_ID
    );

    expect(resolved.resolveErrors).toHaveLength(0);
    expect(resolved.hief).toBeDefined();
    expect(resolved.hief!.input.token).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(resolved.hief!.input.amount).toBe('100000000'); // 100 USDC with 6 decimals
    expect(resolved.hief!.outputs[0].token).toBe('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
    expect(resolved.hief!.constraints.slippageBps).toBe(50);
    expect(resolved.hief!.smartAccount).toBe(MOCK_SMART_ACCOUNT);
    expect(resolved.hief!.chainId).toBe(BASE_CHAIN_ID);
    expect(resolved.hief!.intentId).toMatch(/^0x/);
    expect((resolved.hief!.meta?.uiHints as any)?.inputTokenSymbol).toBe('USDC');
    expect((resolved.hief!.meta?.uiHints as any)?.outputTokenSymbol).toBe('ETH');
  });

  test('parseAndResolve returns error for unknown token', async () => {
    mockLLMResponse({
      intentType: 'SWAP',
      confidence: 0.9,
      params: {
        inputToken: 'UNKNOWN_XYZ',
        inputAmount: '100',
        outputToken: 'ETH',
        minOutputAmount: null,
        slippageBps: null,
        deadline: null,
        targetChain: null,
        protocol: null,
        extraParams: {},
      },
      missingFields: [],
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawIntent: 'swap 100 UNKNOWN_XYZ to ETH',
    });

    const resolved = await parser.parseAndResolve(
      'swap 100 UNKNOWN_XYZ to ETH',
      MOCK_SMART_ACCOUNT,
      BASE_CHAIN_ID
    );

    expect(resolved.hief).toBeUndefined();
    expect(resolved.resolveErrors.length).toBeGreaterThan(0);
    expect(resolved.resolveErrors[0]).toContain('Unknown token');
  });

  test('parseAndResolve returns unsupported error for BRIDGE', async () => {
    mockLLMResponse({
      intentType: 'BRIDGE',
      confidence: 0.95,
      params: {
        inputToken: 'ETH',
        inputAmount: '1',
        outputToken: 'ETH',
        minOutputAmount: null,
        slippageBps: null,
        deadline: null,
        targetChain: 'Arbitrum',
        protocol: null,
        extraParams: {},
      },
      missingFields: [],
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawIntent: 'bridge 1 ETH to Arbitrum',
    });

    const resolved = await parser.parseAndResolve(
      'bridge 1 ETH to Arbitrum',
      MOCK_SMART_ACCOUNT,
      BASE_CHAIN_ID
    );

    expect(resolved.hief).toBeUndefined();
    expect(resolved.resolveErrors[0]).toContain('not yet supported');
  });

  // ─── DEPOSIT tests ────────────────────────────────────────────────────────────

  test('parseAndResolve builds valid HIEFIntent for DEPOSIT (Aave USDC)', async () => {
    mockLLMResponse({
      intentType: 'DEPOSIT',
      confidence: 0.98,
      params: {
        inputToken: 'USDC',
        inputAmount: '100',
        outputToken: 'aUSDC',
        minOutputAmount: null,
        slippageBps: null,
        deadline: null,
        targetChain: null,
        protocol: 'aave',
        extraParams: {},
      },
      missingFields: [],
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawIntent: 'deposit 100 USDC to Aave',
    });

    const resolved = await parser.parseAndResolve(
      'deposit 100 USDC to Aave',
      MOCK_SMART_ACCOUNT,
      BASE_CHAIN_ID
    );

    expect(resolved.resolveErrors).toHaveLength(0);
    expect(resolved.hief).toBeDefined();
    const intent = resolved.hief!;
    // Input: USDC on Base
    expect(intent.input.token).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(intent.input.amount).toBe('100000000');
    // Output: placeholder address (solver fills real aToken), min = input (1:1)
    expect(intent.outputs[0].token).toBe('0x0000000000000000000000000000000000000000');
    expect(intent.outputs[0].minAmount).toBe('100000000');
    // Lending is 1:1, no slippage
    expect(intent.constraints.slippageBps).toBe(0);
    // Tags and hints
    expect(intent.meta?.tags?.[0]).toBe('DEPOSIT');
    expect((intent.meta?.uiHints as any)?.inputTokenSymbol).toBe('USDC');
    expect((intent.meta?.uiHints as any)?.outputTokenSymbol).toBe('aUSDC');
    expect((intent.meta?.uiHints as any)?.protocol).toBe('aave');
  });

  test('parseAndResolve builds valid HIEFIntent for DEPOSIT (ETH, no output token specified)', async () => {
    mockLLMResponse({
      intentType: 'DEPOSIT',
      confidence: 0.97,
      params: {
        inputToken: 'ETH',
        inputAmount: '0.5',
        outputToken: null,
        minOutputAmount: null,
        slippageBps: null,
        deadline: null,
        targetChain: null,
        protocol: 'aave',
        extraParams: {},
      },
      missingFields: [],
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawIntent: 'deposit 0.5 ETH to Aave',
    });

    const resolved = await parser.parseAndResolve(
      'deposit 0.5 ETH to Aave',
      MOCK_SMART_ACCOUNT,
      BASE_CHAIN_ID
    );

    expect(resolved.resolveErrors).toHaveLength(0);
    const intent = resolved.hief!;
    expect(intent.input.amount).toBe('500000000000000000');
    // No outputToken → placeholder address, outputSymbol = aETH
    expect(intent.outputs[0].token).toBe('0x0000000000000000000000000000000000000000');
    expect((intent.meta?.uiHints as any)?.outputTokenSymbol).toBe('aETH');
    expect(intent.constraints.slippageBps).toBe(0);
  });

  test('parseAndResolve DEPOSIT: Chinese input "存100 USDC 到 Aave"', async () => {
    mockLLMResponse({
      intentType: 'DEPOSIT',
      confidence: 0.96,
      params: {
        inputToken: 'USDC',
        inputAmount: '100',
        outputToken: null,
        minOutputAmount: null,
        slippageBps: null,
        deadline: null,
        targetChain: null,
        protocol: 'aave',
        extraParams: {},
      },
      missingFields: [],
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawIntent: '存100 USDC 到 Aave',
    });

    const resolved = await parser.parseAndResolve(
      '存100 USDC 到 Aave',
      MOCK_SMART_ACCOUNT,
      BASE_CHAIN_ID
    );

    expect(resolved.resolveErrors).toHaveLength(0);
    expect(resolved.hief).toBeDefined();
    expect(resolved.hief!.meta?.tags?.[0]).toBe('DEPOSIT');
    expect(resolved.hief!.input.amount).toBe('100000000');
  });

  // ─── WITHDRAW tests ───────────────────────────────────────────────────────────

  test('parseAndResolve builds valid HIEFIntent for WITHDRAW (Aave USDC)', async () => {
    mockLLMResponse({
      intentType: 'WITHDRAW',
      confidence: 0.97,
      params: {
        inputToken: 'USDC',
        inputAmount: '50',
        outputToken: null,
        minOutputAmount: null,
        slippageBps: null,
        deadline: null,
        targetChain: null,
        protocol: 'aave',
        extraParams: {},
      },
      missingFields: [],
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawIntent: 'withdraw 50 USDC from Aave',
    });

    const resolved = await parser.parseAndResolve(
      'withdraw 50 USDC from Aave',
      MOCK_SMART_ACCOUNT,
      BASE_CHAIN_ID
    );

    expect(resolved.resolveErrors).toHaveLength(0);
    const intent = resolved.hief!;
    // Input: USDC
    expect(intent.input.amount).toBe('50000000');
    // Output: same token as input (underlying returned to user)
    expect(intent.outputs[0].token).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(intent.outputs[0].minAmount).toBe('50000000');
    // No slippage for lending withdraw
    expect(intent.constraints.slippageBps).toBe(0);
    expect(intent.meta?.tags?.[0]).toBe('WITHDRAW');
    expect((intent.meta?.uiHints as any)?.outputTokenSymbol).toBe('USDC');
  });

  test('parseAndResolve WITHDRAW: Chinese input "从 Aave 取出 0.1 ETH"', async () => {
    mockLLMResponse({
      intentType: 'WITHDRAW',
      confidence: 0.95,
      params: {
        inputToken: 'ETH',
        inputAmount: '0.1',
        outputToken: null,
        minOutputAmount: null,
        slippageBps: null,
        deadline: null,
        targetChain: null,
        protocol: 'aave',
        extraParams: {},
      },
      missingFields: [],
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawIntent: '从 Aave 取出 0.1 ETH',
    });

    const resolved = await parser.parseAndResolve(
      '从 Aave 取出 0.1 ETH',
      MOCK_SMART_ACCOUNT,
      BASE_CHAIN_ID
    );

    expect(resolved.resolveErrors).toHaveLength(0);
    const intent = resolved.hief!;
    expect(intent.input.amount).toBe('100000000000000000');
    // WITHDRAW returns underlying — output = same address as input (ETH)
    expect(intent.outputs[0].token).not.toBe('0x0000000000000000000000000000000000000000');
    expect(intent.constraints.slippageBps).toBe(0);
    expect(intent.meta?.tags?.[0]).toBe('WITHDRAW');
  });

  test('parseAndResolve DEPOSIT: returns error for unknown token', async () => {
    mockLLMResponse({
      intentType: 'DEPOSIT',
      confidence: 0.9,
      params: {
        inputToken: 'SHIB',
        inputAmount: '1000000',
        outputToken: null,
        minOutputAmount: null,
        slippageBps: null,
        deadline: null,
        targetChain: null,
        protocol: 'aave',
        extraParams: {},
      },
      missingFields: [],
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawIntent: 'deposit 1000000 SHIB to Aave',
    });

    const resolved = await parser.parseAndResolve(
      'deposit 1000000 SHIB to Aave',
      MOCK_SMART_ACCOUNT,
      BASE_CHAIN_ID
    );

    expect(resolved.hief).toBeUndefined();
    expect(resolved.resolveErrors[0]).toContain('Unknown token');
  });

  test('parseAndResolve returns unsupported error for STAKE', async () => {
    mockLLMResponse({
      intentType: 'STAKE',
      confidence: 0.93,
      params: {
        inputToken: 'ETH',
        inputAmount: '1',
        outputToken: 'stETH',
        minOutputAmount: null,
        slippageBps: null,
        deadline: null,
        targetChain: null,
        protocol: 'lido',
        extraParams: {},
      },
      missingFields: [],
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawIntent: 'stake 1 ETH on Lido',
    });

    const resolved = await parser.parseAndResolve(
      'stake 1 ETH on Lido',
      MOCK_SMART_ACCOUNT,
      BASE_CHAIN_ID
    );

    expect(resolved.hief).toBeUndefined();
    expect(resolved.resolveErrors[0]).toContain('not yet supported');
  });
});

// ─── ConversationEngine Tests ──────────────────────────────────────────────────

describe('ConversationEngine', () => {
  let engine: ConversationEngine;
  let mockCreate: jest.Mock;

  beforeEach(() => {
    const OpenAI = require('openai').default;
    engine = new ConversationEngine({ apiKey: 'test-key' });
    // Access the internal parser's mock
    mockCreate = (engine as any).client.chat.completions.create;
    // Also mock the parser's client
    (engine as any).parser.client = (engine as any).client;
  });

  test('creates a session with correct defaults', () => {
    const sessionId = engine.createSession(MOCK_SMART_ACCOUNT, BASE_CHAIN_ID);
    expect(sessionId).toMatch(/^sess_/);
    const session = engine.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.smartAccount).toBe(MOCK_SMART_ACCOUNT);
    expect(session!.chainId).toBe(BASE_CHAIN_ID);
    expect(session!.state).toBe('IDLE');
  });

  test('returns null for non-existent session', () => {
    expect(engine.getSession('nonexistent')).toBeNull();
  });

  test('full conversation: parse → confirm → execute', async () => {
    const sessionId = engine.createSession(MOCK_SMART_ACCOUNT, BASE_CHAIN_ID);

    // Step 1: User sends swap instruction
    mockCreate
      // Parser call
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              intentType: 'SWAP',
              confidence: 0.99,
              params: {
                inputToken: 'USDC', inputAmount: '100', outputToken: 'ETH',
                minOutputAmount: null, slippageBps: 50, deadline: 3600,
                targetChain: null, protocol: null, extraParams: {},
              },
              missingFields: [],
              clarificationNeeded: false,
              clarificationQuestion: null,
              rawIntent: 'swap 100 USDC to ETH',
            }),
          },
        }],
      })
      // Confirmation message generation
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: '📋 Swap 100 USDC → ETH on Base. Slippage: 0.50%. Reply yes to confirm.',
          },
        }],
      });

    const turn1 = await engine.processMessage(sessionId, 'swap 100 USDC to ETH');
    expect(turn1.state).toBe('AWAITING_CONFIRMATION');
    expect(turn1.agentResponse).toContain('confirm');

    // Step 2: User confirms
    const turn2 = await engine.processMessage(sessionId, 'yes');
    expect(turn2.state).toBe('CONFIRMED');
    expect(turn2.intent).toBeDefined();
    expect(turn2.intent!.input.amount).toBe('100000000');
  });

  test('conversation: clarification flow', async () => {
    const sessionId = engine.createSession(MOCK_SMART_ACCOUNT, BASE_CHAIN_ID);

    // Step 1: Ambiguous message
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            intentType: 'SWAP',
            confidence: 0.8,
            params: {
              inputToken: 'ETH', inputAmount: null, outputToken: 'USDC',
              minOutputAmount: null, slippageBps: null, deadline: null,
              targetChain: null, protocol: null, extraParams: {},
            },
            missingFields: ['inputAmount'],
            clarificationNeeded: true,
            clarificationQuestion: '您想换多少 ETH？',
            rawIntent: '把ETH换成USDC',
          }),
        },
      }],
    });

    const turn1 = await engine.processMessage(sessionId, '把ETH换成USDC');
    expect(turn1.state).toBe('AWAITING_CLARIFICATION');
    expect(turn1.agentResponse).toBe('您想换多少 ETH？');

    // Step 2: User provides amount — goes through amendment path
    // Amendment detection call
    mockCreate
      // Amendment LLM call
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              updates: { inputAmount: '0.5' },
              understood: true,
              clarificationNeeded: false,
              clarificationQuestion: null,
            }),
          },
        }],
      })
      // Re-parse with updated params
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              intentType: 'SWAP',
              confidence: 0.99,
              params: {
                inputToken: 'ETH', inputAmount: '0.5', outputToken: 'USDC',
                minOutputAmount: null, slippageBps: 50, deadline: 3600,
                targetChain: null, protocol: null, extraParams: {},
              },
              missingFields: [],
              clarificationNeeded: false,
              clarificationQuestion: null,
              rawIntent: 'swap 0.5 ETH to USDC',
            }),
          },
        }],
      })
      // Confirmation message
      .mockResolvedValueOnce({
        choices: [{
          message: { content: '📋 Swap 0.5 ETH → USDC on Base. Reply yes to confirm.' },
        }],
      });

    const turn2 = await engine.processMessage(sessionId, '0.5 ETH');
    expect(turn2.state).toBe('AWAITING_CONFIRMATION');
    expect(turn2.intent).toBeDefined();
    expect(turn2.intent!.input.amount).toBe('500000000000000000');
  });

  test('conversation: user cancels transaction', async () => {
    const sessionId = engine.createSession(MOCK_SMART_ACCOUNT, BASE_CHAIN_ID);

    // Parse
    mockCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              intentType: 'SWAP', confidence: 0.99,
              params: { inputToken: 'USDC', inputAmount: '100', outputToken: 'ETH',
                minOutputAmount: null, slippageBps: 50, deadline: 3600,
                targetChain: null, protocol: null, extraParams: {} },
              missingFields: [], clarificationNeeded: false,
              clarificationQuestion: null, rawIntent: 'swap 100 USDC to ETH',
            }),
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Confirm swap 100 USDC → ETH? Reply yes/no.' } }],
      });

    await engine.processMessage(sessionId, 'swap 100 USDC to ETH');

    const turn2 = await engine.processMessage(sessionId, 'no');
    expect(turn2.state).toBe('CANCELLED');
    expect(turn2.agentResponse).toContain('cancelled');
  });
});
