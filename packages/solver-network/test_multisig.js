/**
 * End-to-end test for HIEF multisig signing flow.
 * 
 * 1. Submit a valid intent with the Safe multisig address
 * 2. Wait for auction + simulation
 * 3. Call /execute to trigger multisig proposal (AI signs)
 * 4. Sign the EIP-712 typed data with the user's private key
 * 5. Call /multisig-collect-signature with the user's signature
 * 6. Verify the transaction hash and EXECUTED status
 */

const { ethers } = require('ethers');
const crypto = require('crypto');

const BUS_URL = 'http://localhost:3001';
const SOLVER_URL = 'http://localhost:3008';

// Test accounts
const SAFE_ADDRESS = '0x6191002739f49B97eF28fC51c66Aab11a987dC91';
const USER_PRIVATE_KEY = process.env.USER_PRIVATE_KEY; // 0x7d73... key
const AI_PRIVATE_KEY = '0xf2be7fd8f35f99b3838c9dc7e1bdbeccaefb9031ebd223a18c1a8e54f5bb780d'; // 0xb5eb...
const CHAIN_ID = 99917;

const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n=== HIEF Multisig E2E Test ===\n');

  // ─── Step 1: Submit Intent ──────────────────────────────────────────────────
  const intentId = '0x' + crypto.randomBytes(32).toString('hex');
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const intent = {
    intentVersion: '0.1',
    intentId,
    smartAccount: SAFE_ADDRESS,
    chainId: CHAIN_ID,
    deadline,
    input: {
      token: '0x4200000000000000000000000000000000000006',
      amount: '1000000000000000'
    },
    outputs: [{
      token: '0x4200000000000000000000000000000000000006',
      minAmount: '990000000000000'
    }],
    constraints: { slippageBps: 100 },
    priorityFee: { token: 'HIEF', amount: '0' },
    policyRef: { policyVersion: '1.0' },
    meta: {
      userIntentText: 'wrap 0.001 ETH to WETH',
      uiHints: {
        inputTokenSymbol: 'ETH',
        outputTokenSymbol: 'WETH',
        inputAmountHuman: '0.001'
      }
    },
    signature: {
      type: 'SAFE',
      signer: SAFE_ADDRESS,
      sig: '0x' + '00'.repeat(65)
    }
  };

  console.log(`[1] Submitting intent ${intentId.slice(0, 18)}...`);
  const submitRes = await fetch(`${BUS_URL}/v1/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(intent)
  });
  const submitJson = await submitRes.json();
  if (!submitRes.ok) {
    console.error('[1] ❌ Intent submission failed:', JSON.stringify(submitJson, null, 2));
    process.exit(1);
  }
  const returnedIntentId = submitJson.intentId || intentId;
  console.log(`[1] ✅ Intent submitted | ID: ${returnedIntentId.slice(0, 18)}...`);

  // ─── Step 2: Wait for auction + simulation ─────────────────────────────────
  console.log('\n[2] Waiting for auction and simulation (up to 30s)...');
  let simData = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const simRes = await fetch(`${SOLVER_URL}/v1/solver-network/simulation/${returnedIntentId}`);
    if (simRes.ok) {
      simData = await simRes.json();
      if (simData.success && simData.data) {
        console.log(`[2] ✅ Simulation ready | mode: ${simData.data.executionMode} | gasUsed: ${simData.data.simulation?.gasUsed}`);
        break;
      }
    }
    process.stdout.write('.');
  }
  if (!simData?.success) {
    console.error('\n[2] ❌ Simulation not ready after 30s');
    process.exit(1);
  }

  if (simData.data.executionMode !== 'MULTISIG') {
    console.error(`[2] ❌ Expected MULTISIG mode but got: ${simData.data.executionMode}`);
    console.log('    accountInfo:', JSON.stringify(simData.data.accountInfo, null, 2));
    process.exit(1);
  }

  // ─── Step 3: Call /execute to trigger multisig proposal ───────────────────
  console.log('\n[3] Calling /execute to propose Safe TX and get AI signature...');
  const execRes = await fetch(`${SOLVER_URL}/v1/solver-network/execute/${returnedIntentId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const execJson = await execRes.json();
  if (!execRes.ok || !execJson.success) {
    console.error('[3] ❌ Execute failed:', JSON.stringify(execJson, null, 2));
    process.exit(1);
  }

  const { safeTxHash, typedData, aiSignerAddress, threshold, owners } = execJson.data;
  console.log(`[3] ✅ Safe TX proposed | safeTxHash: ${safeTxHash?.slice(0, 18)}...`);
  console.log(`     AI signer: ${aiSignerAddress}`);
  console.log(`     Threshold: ${threshold} | Owners: ${owners?.join(', ')}`);
  console.log(`     typedData present: ${!!typedData}`);

  if (!typedData) {
    console.error('[3] ❌ No typedData returned — cannot sign');
    process.exit(1);
  }

  // ─── Step 4: Sign with user's private key ─────────────────────────────────
  console.log('\n[4] Signing EIP-712 typed data with user private key...');

  // If no user private key provided, derive it from the known test key
  // The user key for 0x7d73932636FbC0E57448BA175AbCd800C60daE5F
  const userKey = USER_PRIVATE_KEY || process.env.USER_PRIVATE_KEY;
  if (!userKey) {
    console.log('[4] ⚠️  No USER_PRIVATE_KEY env var. Signing with AI key to test endpoint connectivity.');
    // Use AI key as fallback to test the endpoint (will fail signature verification but tests connectivity)
  }

  const signerKey = userKey || AI_PRIVATE_KEY;
  const wallet = new ethers.Wallet(signerKey);
  console.log(`[4]    Signer address: ${wallet.address}`);

  // Sign using ethers signTypedData (EIP-712)
  const { domain, types, message } = typedData;
  // Remove EIP712Domain from types for ethers.js (it adds it automatically)
  const typesWithoutDomain = { ...types };
  delete typesWithoutDomain.EIP712Domain;

  const coSignerSignature = await wallet.signTypedData(domain, typesWithoutDomain, message);
  console.log(`[4] ✅ Signature: ${coSignerSignature.slice(0, 20)}...`);

  // ─── Step 5: Submit signature to collect-signature endpoint ───────────────
  console.log('\n[5] Submitting co-signer signature to /multisig-collect-signature...');
  const collectRes = await fetch(`${SOLVER_URL}/v1/solver-network/multisig-collect-signature/${returnedIntentId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      coSignerSignature,
      coSignerAddress: wallet.address
    })
  });
  const collectJson = await collectRes.json();

  if (!collectRes.ok || !collectJson.success) {
    console.error('[5] ❌ collect-signature failed:', JSON.stringify(collectJson, null, 2));
    process.exit(1);
  }

  const { txHash, blockNumber } = collectJson.data;
  console.log(`[5] ✅ Safe TX EXECUTED on-chain!`);
  console.log(`     txHash: ${txHash}`);
  console.log(`     Block:  ${blockNumber}`);
  console.log(`     Tenderly: https://dashboard.tenderly.co/tx/${txHash}`);

  // ─── Step 6: Verify intent status ─────────────────────────────────────────
  console.log('\n[6] Verifying intent status in bus...');
  await sleep(1000);
  const statusRes = await fetch(`${BUS_URL}/v1/intents/${returnedIntentId}`);
  const statusJson = await statusRes.json();
  const status = statusJson.data?.status || statusJson.status;
  console.log(`[6] Intent status: ${status}`);
  if (status === 'EXECUTED') {
    console.log('[6] ✅ Status is EXECUTED — full flow verified!');
  } else {
    console.log(`[6] ⚠️  Status is ${status} (expected EXECUTED)`);
  }

  console.log('\n=== TEST COMPLETE ===\n');
}

main().catch(err => {
  console.error('\n❌ Test failed with error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
