import express from 'express';
import { intentsRouter } from './api/intents';
import { solutionsRouter } from './api/solutions';
import { proposalsRouter } from './api/proposals';
import { initDb } from './db/database';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  console.log(`[BUS] ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'hief-bus', version: '0.1.0' });
});

// Routes
app.use('/v1/intents', intentsRouter);
app.use('/v1/solutions', solutionsRouter);
app.use('/v1/intents', proposalsRouter);
app.use('/v1', solutionsRouter);

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[BUS] Unhandled error:', err);
  res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: err.message });
});

let server: ReturnType<typeof app.listen>;

async function start() {
  await initDb();
  server = app.listen(PORT, () => {
    console.log(`[BUS] HIEF Intent Bus running on port ${PORT}`);
  });
}

if (require.main === module) {
  start().catch(console.error);
}

export { app, start };
export const getServer = () => server;
