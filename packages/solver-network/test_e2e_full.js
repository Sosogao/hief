/**
 * Full E2E test using the local gateway (with updated dist code).
 * 
 * Since the gateway is running with the old code, we test the endpoint
 * directly using the new signing logic.
 */
const { ethers } = require('ethers');
const crypto = require('crypto');

const BUS_URL = 'http://localhost:3001';
const SOLVER_URL = 'http://localhost:3008';
const USER_KEY = process.env.USER_PRIVATE_KEY;
const AI_KEY = '0xf2be7fd8f35f99b3838c9dc7e1bdbeccaefb9031ebd223a18c1a8e54f5bb780d';
const SAFE_ADDRESS = '0x6191002739f49B97eF28fC51c66Aab11a987dC91';
const CHAIN_ID = 99917;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!USER_KEY) { console.error('❌ Set USER_PRIVATE_KEY'); process.exit(1); }

  const userWallet = new ethers.Wallet(USER_KEY);
  console.log(`\n=== HIEF Multisig E2E Test (Fixed EIP-712 Signing) ===`);
  console.log(`User: ${userWallet.address}`);

  // ─── Step 1: Submit Intent ──────────────────────────────────────────────────
  const intentId = '0x' + crypto.randomBytes(32).toString('hex');
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const intent = {
    intentVersion: '0.1', intentId,
    smartAccount: SAFE_ADDRESS,
    chainId: CHAIN_ID, deadline,
    input: { token: '0x4200000000000000000000000000000000000006', amount: '1000000000000000' },
    outputs: [{ token: '0x4200000000000000000000000000000000000006', minAmount: '990000000000000' }],
    constraints: { slippageBps: 100 },
    priorityFee: { token: 'HIEF', amount: '0' },
    policyRef: { policyVersion: '1.0' },
    meta: { userIntentText: 'wrap 0.001 ETH to WETH' },
    signature: { type: 'SAFE', signer: SAFE_ADDRESS, sig: '0x' + '00'.repeat(65) }
  };

  console.log(`\n[1] Submitting intent...`);
  const submitRes = await fetch(`${BUS_URL}/v1/intents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent)
  });
  const submitJson = await submitRes.json();
  if (!submitRes.ok) { console.error('[1] ❌', JSON.stringify(submitJson)); process.exit(1); }
  const rid = submitJson.intentId || intentId;
  console.log(`[1] ✅ Intent submitted | ID: ${rid.slice(0,18)}...`);

  // ─── Step 2: Wait for simulation ──────────────────────────────────────────
  console.log(`\n[2] Waiting for simulation...`);
  let simData = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const r = await fetch(`${SOLVER_URL}/v1/solver-network/simulation/${rid}`);
    if (r.ok) { simData = await r.json(); if (simData.success && simData.data) break; }
    process.stdout.write('.');
  }
  if (!simData?.success) { console.error('\n[2] ❌ No simulation'); process.exit(1); }
  console.log(`\n[2] ✅ mode=${simData.data.executionMode} | gas=${simData.data.simulation?.gasUsed}`);
  if (simData.data.executionMode !== 'MULTISIG') { console.error('[2] ❌ Not MULTISIG'); process.exit(1); }

  // ─── Step 3: Execute (AI proposes + signs) ────────────────────────────────
  console.log(`\n[3] Calling /execute (AI signs with EIP-712)...`);
  const execRes = await fetch(`${SOLVER_URL}/v1/solver-network/execute/${rid}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  });
  const execJson = await execRes.json();
  if (!execRes.ok || !execJson.success) { console.error('[3] ❌', JSON.stringify(execJson)); process.exit(1); }
  const { safeTxHash, typedData, aiSignerAddress } = execJson.data;
  console.log(`[3] ✅ safeTxHash: ${safeTxHash?.slice(0,18)}... | AI: ${aiSignerAddress}`);
  if (!typedData) { console.error('[3] ❌ No typedData'); process.exit(1); }

  // ─── Step 4: User signs with EIP-712 ─────────────────────────────────────
  console.log(`\n[4] User signing with EIP-712 (signTypedData)...`);
  const { domain, types, message } = typedData;
  const typesNoDomain = { ...types };
  delete typesNoDomain.EIP712Domain;
  const coSignerSignature = await userWallet.signTypedData(domain, typesNoDomain, message);
  console.log(`[4] ✅ User sig: ${coSignerSignature.slice(0,20)}...`);

  // ─── Step 5: Submit to collect-signature ─────────────────────────────────
  console.log(`\n[5] Submitting to /multisig-collect-signature...`);
  const collectRes = await fetch(`${SOLVER_URL}/v1/solver-network/multisig-collect-signature/${rid}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coSignerSignature, coSignerAddress: userWallet.address })
  });
  const collectJson = await collectRes.json();
  if (!collectRes.ok || !collectJson.success) {
    console.error('[5] ❌', JSON.stringify(collectJson));
    process.exit(1);
  }
  const { txHash, blockNumber } = collectJson.data;
  console.log(`[5] ✅ EXECUTED! txHash: ${txHash} | block: ${blockNumber}`);

  // ─── Step 6: Verify intent status ─────────────────────────────────────────
  await sleep(1000);
  const statusRes = await fetch(`${BUS_URL}/v1/intents/${rid}`);
  const statusJson = await statusRes.json();
  const status = statusJson.data?.status || statusJson.status;
  console.log(`\n[6] Intent status: ${status}`);
  console.log(status === 'EXECUTED' ? '[6] ✅ EXECUTED — full flow verified!' : `[6] ⚠️  ${status}`);
  console.log('\n=== TEST COMPLETE ===\n');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
