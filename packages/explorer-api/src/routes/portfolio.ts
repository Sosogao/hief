/**
 * Portfolio route — proxies DeBank Pro API to fetch DeFi positions and token balances.
 * Requires DEBANK_API_KEY env var.
 * Cache: 30s in-memory per (address, chain).
 */
import { Router, Request, Response } from 'express';
import axios from 'axios';

export const portfolioRouter = Router();

const DEBANK_BASE = 'https://pro-openapi.debank.com/v1';
const CACHE_TTL   = 30_000; // ms

const _cache = new Map<string, { data: unknown; ts: number }>();

portfolioRouter.get('/:address', async (req: Request, res: Response) => {
  const { address } = req.params;
  if (!/^0x[0-9a-fA-F]{40}$/i.test(address)) {
    return res.status(400).json({ success: false, error: 'Invalid address' });
  }

  const chain  = (req.query.chain as string) || 'eth';
  const apiKey = process.env.DEBANK_API_KEY;
  if (!apiKey) {
    return res.json({ success: false, error: 'DEBANK_API_KEY not configured', data: null });
  }

  const cacheKey = `${address.toLowerCase()}:${chain}`;
  const cached   = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ success: true, data: cached.data, cached: true });
  }

  try {
    const headers = { AccessKey: apiKey };
    const id      = address.toLowerCase();
    const timeout = 10_000;

    const [protocolsRes, tokensRes] = await Promise.all([
      axios.get(`${DEBANK_BASE}/user/all_complex_protocol_list`, {
        params: { id, chain_id: chain }, headers, timeout,
      }),
      axios.get(`${DEBANK_BASE}/user/token_list`, {
        params: { id, chain_id: chain, is_all: false }, headers, timeout,
      }),
    ]);

    const data = {
      protocols: protocolsRes.data as unknown[],
      tokens:    tokensRes.data    as unknown[],
    };

    _cache.set(cacheKey, { data, ts: Date.now() });
    res.json({ success: true, data, cached: false });
  } catch (err: any) {
    const status  = err.response?.status  ?? 502;
    const message = err.response?.data?.message ?? err.message;
    res.status(status).json({ success: false, error: message });
  }
});

