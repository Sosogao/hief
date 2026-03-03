import express from 'express';
import { ConversationEngine } from './conversation/conversationEngine';
import { IntentParser } from './parser/intentParser';

const app = express();
const PORT = process.env.PORT || 3004;

app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  console.log(`[AGENT] ${req.method} ${req.path}`);
  next();
});

const engine = new ConversationEngine();
const parser = new IntentParser();

// ─── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'hief-agent', version: '0.1.0' });
});

// ─── Session Management ────────────────────────────────────────────────────────

/**
 * POST /v1/agent/sessions
 * Create a new conversation session.
 */
app.post('/v1/agent/sessions', (req, res) => {
  const { smartAccount, chainId } = req.body;
  if (!smartAccount) {
    return res.status(400).json({ errorCode: 'MISSING_FIELDS', message: 'smartAccount is required' });
  }
  const sessionId = engine.createSession(smartAccount, chainId ?? 8453);
  return res.status(201).json({ sessionId, smartAccount, chainId: chainId ?? 8453 });
});

/**
 * GET /v1/agent/sessions/:sessionId
 * Get session state and message history.
 */
app.get('/v1/agent/sessions/:sessionId', (req, res) => {
  const session = engine.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ errorCode: 'SESSION_NOT_FOUND' });
  return res.json(session);
});

// ─── Conversation ──────────────────────────────────────────────────────────────

/**
 * POST /v1/agent/sessions/:sessionId/messages
 * Send a message to the agent and get a response.
 *
 * This is the main entry point for the AI DeFi interaction.
 */
app.post('/v1/agent/sessions/:sessionId/messages', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ errorCode: 'MISSING_FIELDS', message: 'message is required' });
  }

  const session = engine.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ errorCode: 'SESSION_NOT_FOUND' });

  try {
    const turn = await engine.processMessage(req.params.sessionId, message);
    return res.json({
      sessionId: req.params.sessionId,
      agentResponse: turn.agentResponse,
      state: turn.state,
      intent: turn.intent ?? null,
    });
  } catch (err: any) {
    console.error('[AGENT] Message processing error:', err.message);
    return res.status(500).json({ errorCode: 'AGENT_ERROR', message: err.message });
  }
});

// ─── Direct Parse (no session) ────────────────────────────────────────────────

/**
 * POST /v1/agent/parse
 * Directly parse a natural language instruction without session management.
 * Useful for testing and integration.
 */
app.post('/v1/agent/parse', async (req, res) => {
  const { message, smartAccount, chainId } = req.body;
  if (!message || !smartAccount) {
    return res.status(400).json({ errorCode: 'MISSING_FIELDS', message: 'message and smartAccount are required' });
  }

  try {
    const resolved = await parser.parseAndResolve(message, smartAccount, chainId ?? 8453);
    return res.json({
      parseResult: resolved.parseResult,
      intent: resolved.hief ?? null,
      resolveErrors: resolved.resolveErrors,
      ready: resolved.hief !== undefined && resolved.resolveErrors.length === 0,
    });
  } catch (err: any) {
    console.error('[AGENT] Parse error:', err.message);
    return res.status(500).json({ errorCode: 'PARSE_ERROR', message: err.message });
  }
});

// ─── Error handler ─────────────────────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[AGENT] Unhandled error:', err);
  res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`[AGENT] HIEF AI Agent running on port ${PORT}`);
  console.log(`[AGENT] Model: ${process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'}`);
});

export { app, server };
