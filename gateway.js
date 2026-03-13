/**
 * HIEF Unified Gateway
 * 
 * Runs all microservices as child processes and exposes a single HTTP gateway
 * that proxies requests to the appropriate service based on path prefix.
 * 
 * This allows deploying the entire HIEF platform as a single Railway service.
 */

const http = require('http');
const httpProxy = require('http-proxy');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const GATEWAY_PORT = parseInt(process.env.PORT || '8080', 10);

// ─── Service Definitions ──────────────────────────────────────────────────────
const SERVICES = [
  {
    name: 'bus',
    port: 3001,
    dir: 'packages/bus',
    cmd: 'node',
    args: ['dist/server.js'],
    buildCmd: 'npx tsc --noEmit false',
    env: { PORT: '3001' },
    pathPrefixes: ['/v1/intents', '/v1/solutions'],
    healthPath: '/health'
  },
  {
    name: 'policy',
    port: 3003,
    dir: 'packages/policy',
    cmd: 'node',
    args: ['dist/server.js'],
    env: { PORT: '3003' },
    pathPrefixes: ['/v1/policy'],
    healthPath: '/health'
  },
  {
    name: 'agent',
    port: 3004,
    dir: 'packages/agent',
    cmd: 'node',
    args: ['dist/server.js'],
    env: { PORT: '3004' },
    pathPrefixes: ['/v1/agent'],
    healthPath: '/health'
  },
  {
    name: 'reputation',
    port: 3005,
    dir: 'packages/reputation',
    cmd: 'node',
    args: ['dist/api/server.js'],
    env: { REPUTATION_PORT: '3005' },
    pathPrefixes: ['/v1/reputation'],
    healthPath: '/v1/reputation/health'
  },
  {
    name: 'explorer-api',
    port: 3006,
    dir: 'packages/explorer-api',
    cmd: 'node',
    args: ['dist/server.js'],
    env: {
      PORT: '3006',
      EXPLORER_API_PORT: '3006',
      REPUTATION_API_URL: 'http://localhost:3005',
      BUS_DB_PATH: path.join(__dirname, 'packages/bus/data/hief.db')
    },
    pathPrefixes: ['/v1/explorer'],
    healthPath: '/health'
  },
  {
    name: 'nft-sync',
    port: 3007,
    dir: 'packages/nft-sync',
    cmd: 'node',
    args: ['dist/server.js'],
    env: {
      PORT: '3007',
      REPUTATION_API_URL: 'http://localhost:3005'
    },
    pathPrefixes: ['/v1/nft-sync'],
    healthPath: '/health'
  },
  {
    name: 'solver-network',
    port: 3008,
    dir: 'packages/solver-network',
    cmd: 'node',
    args: ['dist/server.js'],
    env: {
      PORT: '3008',
      BUS_URL: 'http://localhost:3001',
      TENDERLY_RPC_URL: 'https://virtual.mainnet.eu.rpc.tenderly.co/34ba02bb-d61a-4c5b-90c6-0d2e9a8f367d',
      SETTLEMENT_CHAIN_ID: '99917',
    },
    pathPrefixes: ['/v1/solver-network'],
    healthPath: '/health'
  }
];

// ─── Build Common Package ───────────────────────────────────────────────────
async function buildCommon() {
  const commonDist = path.join(__dirname, 'packages/common/dist/index.js');
  if (fs.existsSync(commonDist)) {
    console.log('[gateway] @hief/common: dist already exists, skipping');
    return;
  }
  console.log('[gateway] Building @hief/common (shared types)...');
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsc'], {
      cwd: path.join(__dirname, 'packages/common'),
      stdio: 'inherit',
      env: { ...process.env, PATH: process.env.PATH }
    });
    proc.on('close', (code) => {
      if (code === 0) {
        console.log('[gateway] @hief/common: build OK');
        resolve();
      } else {
        console.error('[gateway] @hief/common: build FAILED — services may not start');
        resolve(); // Don't abort gateway startup
      }
    });
  });
}

// ─── Build Services ───────────────────────────────────────────────────────────
async function buildService(svc) {
  const distDir = path.join(__dirname, svc.dir, 'dist');
  const serverJs = path.join(distDir, 'server.js');
  
  if (svc.cmd !== 'node') return true; // tsx/ts-node don't need build
  // Always rebuild — dist may be stale if source changed since last deploy
  console.log(`[gateway] ${svc.name}: building from source...`);
  
  console.log(`[gateway] Building ${svc.name}...`);
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsc'], {
      cwd: path.join(__dirname, svc.dir),
      stdio: 'inherit',
      env: { ...process.env, PATH: process.env.PATH }
    });
    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`[gateway] ${svc.name}: build OK`);
        resolve(true);
      } else {
        console.warn(`[gateway] ${svc.name}: build failed (code ${code}), will try ts-node fallback`);
        resolve(false);
      }
    });
  });
}

// ─── Start Service ────────────────────────────────────────────────────────────
function startService(svc) {
  const cwd = path.join(__dirname, svc.dir);
  const env = {
    ...process.env,
    ...svc.env,
    INTENT_BUS_URL: 'http://localhost:3001',
    POLICY_ENGINE_URL: 'http://localhost:3003',
    REPUTATION_API_URL: 'http://localhost:3005',
    BUS_URL: 'http://localhost:3001',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  };

  // If dist/server.js doesn't exist, fall back to tsx
  let cmd = svc.cmd;
  let args = [...svc.args];
  if (cmd === 'node' && !fs.existsSync(path.join(cwd, args[0]))) {
    console.log(`[gateway] ${svc.name}: dist not found, using tsx fallback`);
    cmd = 'npx';
    args = ['tsx', 'src/server.ts'];
  }

  console.log(`[gateway] Starting ${svc.name} on port ${svc.port}...`);
  const proc = spawn(cmd, args, { cwd, env, stdio: 'pipe' });

  proc.stdout.on('data', (d) => process.stdout.write(`[${svc.name}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[${svc.name}] ${d}`));
  proc.on('close', (code) => {
    console.error(`[gateway] ${svc.name} exited with code ${code}, restarting in 5s...`);
    setTimeout(() => startService(svc), 5000);
  });

  return proc;
}

// ─── Wait for Service ─────────────────────────────────────────────────────────
function waitForService(svc, maxWait = 60000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${svc.port}${svc.healthPath}`, (res) => {
        if (res.statusCode < 500) {
          console.log(`[gateway] ${svc.name} ready on port ${svc.port}`);
          resolve(true);
        } else {
          retry();
        }
        res.resume();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > maxWait) {
        console.warn(`[gateway] ${svc.name} not ready after ${maxWait}ms, continuing anyway`);
        resolve(false);
      } else {
        setTimeout(check, 2000);
      }
    };
    setTimeout(check, 2000);
  });
}

// ─── Proxy Setup ──────────────────────────────────────────────────────────────
const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on('error', (err, req, res) => {
  console.error('[gateway] Proxy error:', err.message);
  if (res && !res.headersSent) {
    const isConnRefused = err.code === 'ECONNREFUSED';
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: isConnRefused ? 'Service starting up' : 'Service unavailable',
      message: isConnRefused
        ? 'This service is still starting. Please wait a few seconds and try again.'
        : err.message,
      retryAfter: 5
    }));
  }
});

function getTargetPort(pathname) {
  for (const svc of SERVICES) {
    for (const prefix of svc.pathPrefixes) {
      if (pathname.startsWith(prefix)) {
        return svc.port;
      }
    }
  }
  return null;
}

// ─── Static Frontend ──────────────────────────────────────────────────────────
const FRONTEND_DIR = path.join(__dirname, 'apps/explorer');

function serveStatic(req, res) {
  let filePath = path.join(FRONTEND_DIR, req.url === '/' ? 'index.html' : req.url);
  
  // Security: prevent path traversal
  if (!filePath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml'
  };
  const contentType = mimeTypes[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fallback to index.html for SPA routing
      fs.readFile(path.join(FRONTEND_DIR, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data2);
        }
      });
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
}

// ─── Gateway Server ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Gateway health check
  if (pathname === '/gateway/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'hief-gateway',
      services: SERVICES.map(s => ({ name: s.name, port: s.port }))
    }));
    return;
  }

  // API routing
  const targetPort = getTargetPort(pathname);
  if (targetPort) {
    proxy.web(req, res, { target: `http://localhost:${targetPort}` });
    return;
  }

  // Serve frontend for all other requests
  serveStatic(req, res);
});

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[gateway] HIEF Platform Gateway starting...');
  console.log(`[gateway] Gateway port: ${GATEWAY_PORT}`);

  // Build @hief/common first (required by all other services)
  await buildCommon();

  // Build compiled services
  for (const svc of SERVICES) {
    await buildService(svc);
  }

  // Start all services
  for (const svc of SERVICES) {
    startService(svc);
  }

  // Wait for critical services before opening gateway
  console.log('[gateway] Waiting for critical services...');
  await Promise.all([
    waitForService(SERVICES.find(s => s.name === 'bus'), 90000),
    waitForService(SERVICES.find(s => s.name === 'reputation'), 90000),
    waitForService(SERVICES.find(s => s.name === 'agent'), 120000),
    waitForService(SERVICES.find(s => s.name === 'explorer-api'), 90000),
    waitForService(SERVICES.find(s => s.name === 'solver-network'), 120000),
  ]);

  // Start gateway
  server.listen(GATEWAY_PORT, () => {
    console.log(`[gateway] ✅ HIEF Gateway running on port ${GATEWAY_PORT}`);
    console.log(`[gateway] Frontend: http://localhost:${GATEWAY_PORT}/`);
    console.log(`[gateway] API: http://localhost:${GATEWAY_PORT}/v1/...`);
  });
}

main().catch((err) => {
  console.error('[gateway] Fatal error:', err);
  process.exit(1);
});
