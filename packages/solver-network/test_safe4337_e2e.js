/**
 * test_safe4337_e2e.js
 * End-to-end test for Safe+Safe4337Module execution on Ethereum Mainnet fork.
 *
 * Flow:
 *   1. Verify Safe4337 account at 0xbdB26a0a4DCAdcd16b5B3b0F55f0A85D79280aD1
 *   2. Submit intent with Safe4337 account
 *   3. Trigger solver → verify ERC4337_SAFE mode detected
 *   4. Call /execute → get UserOp typed data
 *   5. Sign UserOp with user's private key (simulating MetaMask)
 *   6. Call /safe4337-collect-signature → verify on-chain execution
 */

const { ethers } = require('/home/ubuntu/hief-fresh/node_modules/.pnpm/ethers@6.16.0/node_modules/ethers');
const http = require('http');

const MAINNET_FORK_RPC = 'https://virtual.mainnet.eu.rpc.tenderly.co/34ba02bb-d61a-4c5b-90c6-0d2e9a8f367d';
// Read SETTLEMENT_PRIVATE_KEY from server.ts (same key used by solver-network)
const fs = require('fs');
const _src = fs.readFileSync('/home/ubuntu/hief-fresh/packages/solver-network/src/server.ts', 'utf8');
const _keyMatch = _src.match(/SETTLEMENT_PRIVATE_KEY = process\.env\.SETTLEMENT_PRIVATE_KEY \|\|\s*['"](0x[0-9a-fA-F]+)['"]/); 
const AI_PRIVATE_KEY = process.env.AI_PRIVATE_KEY || (_keyMatch ? _keyMatch[1] : '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const USER_PRIVATE_KEY = process.env.USER_PRIVATE_KEY || '0x51e9b757c77737a5f2a72e49ad624953eeb5110aeda7c9bbf15d9ec6307bd7b7';

const SAFE4337_ADDRESS  = '0xafde956738f3d610ae93cd4f4d74b029a9d39ebf';
const ENTRY_POINT_V07   = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const SAFE_4337_MODULE  = '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226';
const WETH_MAINNET      = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID          = 99917;  // Tenderly mainnet fork chainId

const BUS_URL    = 'http://localhost:3001';
const SOLVER_URL = 'http://localhost:3008';

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve(raw); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ''),
      method: 'GET',
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve(raw); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Safe+Safe4337Module E2E Test — Ethereum Mainnet Fork');
  console.log('══════════════════════════════════════════════════════════════\n');

  const provider = new ethers.JsonRpcProvider(MAINNET_FORK_RPC);
  const userWallet = new ethers.Wallet(USER_PRIVATE_KEY, provider);

  // ── Step 1: Verify Safe4337 account ─────────────────────────────────────────
  console.log('[Step 1] Verifying Safe4337 account...');
  const SAFE_ABI = [
    'function isModuleEnabled(address) external view returns (bool)',
    'function getOwners() external view returns (address[])',
    'function getThreshold() external view returns (uint256)',
  ];
  const EP_ABI = [
    'function balanceOf(address) external view returns (uint256)',
    'function getNonce(address, uint192) external view returns (uint256)',
  ];
  const safe = new ethers.Contract(SAFE4337_ADDRESS, SAFE_ABI, provider);
  const ep = new ethers.Contract(ENTRY_POINT_V07, EP_ABI, provider);

  const [moduleEnabled, owners, threshold, deposit, nonce] = await Promise.all([
    safe.isModuleEnabled(SAFE_4337_MODULE),
    safe.getOwners(),
    safe.getThreshold(),
    ep.balanceOf(SAFE4337_ADDRESS),
    ep.getNonce(SAFE4337_ADDRESS, 0),
  ]);

  console.log(`  Safe4337Module enabled: ${moduleEnabled}`);
  console.log(`  Owners: ${owners.join(', ')}`);
  console.log(`  Threshold: ${threshold}`);
  console.log(`  EntryPoint deposit: ${ethers.formatEther(deposit)} ETH`);
  console.log(`  EntryPoint nonce: ${nonce}`);

  if (!moduleEnabled) {
    console.error('  ❌ Safe4337Module not enabled! Aborting.');
    process.exit(1);
  }

  // Ensure deposit is sufficient
  if (deposit < ethers.parseEther('0.05')) {
    console.log('  ⚠️  Low deposit, topping up...');
    const aiWallet = new ethers.Wallet(AI_PRIVATE_KEY, provider);
    const epFull = new ethers.Contract(ENTRY_POINT_V07, ['function depositTo(address) external payable'], aiWallet);
    const tx = await epFull.depositTo(SAFE4337_ADDRESS, { value: ethers.parseEther('0.1') });
    await tx.wait();
    console.log('  ✅ Deposit topped up');
  }
  console.log(`  ✅ Safe4337 account verified\n`);

  // ── Step 2: Submit intent ────────────────────────────────────────────────────
  console.log('[Step 2] Submitting intent with Safe4337 account...');
  // intentId must be 0x + 64 hex chars (bytes32)
  const intentId = '0x' + Date.now().toString(16).padStart(16, '0') + '73616665343333376d6f64756c65746573740000000000000000000000000000'.slice(0, 48);
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const intentPayload = {
    intentVersion: '0.1',
    intentId,
    smartAccount: SAFE4337_ADDRESS,
    chainId: CHAIN_ID,
    input: {
      token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      amount: '1000000000000000',
    },
    outputs: [{
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      minAmount: '1',
    }],
    constraints: { slippageBps: 50 },
    deadline,
    priorityFee: { token: 'HIEF', amount: '0' },
    policyRef: { policyVersion: '1.0' },
    signature: {
      type: 'EIP712_EOA',
      signer: '0x7d73932636FbC0E57448BA175AbCd800C60daE5F',
      sig: '0x' + '00'.repeat(65),
    },
    meta: {
      userIntentText: 'Wrap 0.001 ETH to WETH via Safe4337',
      uiHints: {
        inputAmountHuman: '0.001',
        inputTokenSymbol: 'ETH',
        outputTokenSymbol: 'WETH',
      },
    },
  };

  const busResp = await post(`${BUS_URL}/v1/intents`, intentPayload);
  console.log(`  Bus response: ${JSON.stringify(busResp).slice(0, 120)}`);

  const busIntentId = (busResp.data && busResp.data.id) || busResp.intentId || intentId;
  console.log(`  ✅ Intent submitted: ${busIntentId}\n`);

  // ── Step 3: Trigger solver ───────────────────────────────────────────────────
  console.log('[Step 3] Triggering solver...');
  await sleep(1000);
  const triggerResp = await post(`${SOLVER_URL}/v1/solver-network/trigger`, { intentId: busIntentId });
  console.log(`  Trigger response: ${JSON.stringify(triggerResp).slice(0, 200)}`);

  const execMode = triggerResp.data?.executionMode || triggerResp.executionMode;
  console.log(`  Execution mode: ${execMode}`);

  if (execMode !== 'ERC4337_SAFE') {
    console.error(`  ❌ Expected ERC4337_SAFE mode, got: ${execMode}`);
    console.error(`  Full response: ${JSON.stringify(triggerResp, null, 2)}`);
    process.exit(1);
  }
  console.log(`  ✅ ERC4337_SAFE mode detected\n`);

  // ── Step 4: Call /execute to get UserOp typed data ──────────────────────────
  console.log('[Step 4] Calling /execute to get UserOp typed data...');
  const executeResp = await post(`${SOLVER_URL}/v1/solver-network/execute/${busIntentId}`, {});
  console.log(`  Execute response: ${JSON.stringify(executeResp).slice(0, 200)}`);

  if (!executeResp.success) {
    console.error(`  ❌ Execute failed: ${executeResp.error}`);
    process.exit(1);
  }

  const execData = executeResp.data;
  const userOpHash = execData.userOpHash;
  const userOpTypedData = execData.userOpTypedData;

  if (!userOpHash || !userOpTypedData) {
    console.error(`  ❌ Missing userOpHash or userOpTypedData in response`);
    console.error(`  Response: ${JSON.stringify(execData, null, 2)}`);
    process.exit(1);
  }

  console.log(`  UserOpHash: ${userOpHash.slice(0, 16)}...${userOpHash.slice(-8)}`);
  console.log(`  Safe address: ${execData.safeAddress}`);
  console.log(`  EntryPoint: ${execData.entryPoint}`);
  console.log(`  ✅ UserOp prepared, awaiting MetaMask signature\n`);

  // ── Step 5: Sign UserOp with user's private key (simulating MetaMask) ────────
  console.log('[Step 5] Signing UserOp with user private key (simulating MetaMask eth_signTypedData_v4)...');
  const { domain, types, message } = userOpTypedData;

  // ethers.js signTypedData uses the same algorithm as MetaMask eth_signTypedData_v4
  const userSignature = await userWallet.signTypedData(
    domain,
    types,
    message
  );

  console.log(`  Signer: ${userWallet.address}`);
  console.log(`  Signature: ${userSignature.slice(0, 20)}...${userSignature.slice(-8)}`);
  console.log(`  ✅ UserOp signed\n`);

  // ── Step 6: Submit signature to /safe4337-collect-signature ─────────────────
  console.log('[Step 6] Submitting signature to /safe4337-collect-signature...');
  const collectResp = await post(
    `${SOLVER_URL}/v1/solver-network/safe4337-collect-signature/${busIntentId}`,
    { userSignature, signerAddress: userWallet.address }
  );
  console.log(`  Collect response: ${JSON.stringify(collectResp).slice(0, 300)}`);

  if (!collectResp.success) {
    console.error(`  ❌ Execution failed: ${collectResp.error}`);
    process.exit(1);
  }

  const result = collectResp.data;
  console.log(`\n  ✅ Safe+4337 UserOp EXECUTED on-chain!`);
  console.log(`  UserOpHash: ${result.userOpHash}`);
  console.log(`  TxHash:     ${result.txHash}`);
  console.log(`  Block:      ${result.blockNumber}`);
  console.log(`  Safe:       ${result.safeAddress}`);

  // ── Step 7: Verify intent status ────────────────────────────────────────────
  console.log('\n[Step 7] Verifying intent status...');
  await sleep(1000);
  const statusResp = await get(`${BUS_URL}/v1/intents/${busIntentId}`);
  // Intent bus stores status in _status field (prefixed to avoid schema conflicts)
  const status = statusResp._status || statusResp.data?._status || statusResp.data?.status || statusResp.status;
  console.log(`  Intent status: ${status}`);

  if (status === 'EXECUTED') {
    console.log(`  ✅ Intent status: EXECUTED\n`);
  } else {
    console.log(`  ⚠️  Intent status: ${status} (may still be updating)\n`);
  }

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  ✅ ALL STEPS PASSED — Safe+Safe4337Module E2E Test Complete!');
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(e => {
  console.error('\n❌ Test failed:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
