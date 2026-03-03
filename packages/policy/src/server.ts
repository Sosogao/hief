import express from 'express';
import { validateSolution, validateIntent } from './engine/policyEngine';
import type { HIEFIntent, HIEFSolution } from '@hief/common';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  console.log(`[POLICY] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'hief-policy', version: '0.1.0' });
});

// POST /v1/policy/validateSolution - Full validation (static + simulation)
app.post('/v1/policy/validateSolution', async (req, res) => {
  const { intent, solution } = req.body as { intent: HIEFIntent; solution: HIEFSolution };

  if (!intent || !solution) {
    return res.status(400).json({ errorCode: 'MISSING_FIELDS', message: 'intent and solution are required' });
  }

  try {
    const result = await validateSolution(intent, solution);
    return res.json(result);
  } catch (err: any) {
    console.error('[POLICY] Validation error:', err);
    return res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: err.message });
  }
});

// POST /v1/policy/validateIntent - Lightweight intent pre-validation
app.post('/v1/policy/validateIntent', async (req, res) => {
  const { intent } = req.body as { intent: HIEFIntent };

  if (!intent) {
    return res.status(400).json({ errorCode: 'MISSING_FIELDS', message: 'intent is required' });
  }

  try {
    const result = await validateIntent(intent);
    return res.json(result);
  } catch (err: any) {
    console.error('[POLICY] Intent validation error:', err);
    return res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: err.message });
  }
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[POLICY] Unhandled error:', err);
  res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`[POLICY] HIEF Policy Engine running on port ${PORT}`);
});

export { app, server };
