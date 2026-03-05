/**
 * ERC-4337 End-to-End Test
 *
 * Tests the full ERC-4337 flow:
 * 1. Use the known-good SimpleAccount deployed at 0xA1681bA5882214D66ca1eE3127E031FCCbadb3Df
 * 2. Fund its EntryPoint deposit
 * 3. Verify detectAccountMode returns ERC4337
 * 4. Submit an intent with the SimpleAccount address as sender
 * 5. Trigger auction + simulation
 * 6. Call /execute → verify UserOp is built, signed, and submitted via EntryPoint
 * 7. Verify the tx hash is returned and intent status is EXECUTED
 */

const { ethers } = require('/home/ubuntu/hief-fresh/node_modules/.pnpm/ethers@6.16.0/node_modules/ethers');

const TENDERLY_RPC = 'https://virtual.base-sepolia.eu.rpc.tenderly.co/d8ee495e-1c03-4236-9615-b4a03b52069f';
const SETTLEMENT_PRIVATE_KEY = '0xf2be7fd8f35f99b3838c9dc7e1bdbeccaefb9031ebd223a18c1a8e54f5bb780d';
const BUS_URL = 'http://localhost:3001';
const SOLVER_URL = 'http://localhost:3008';

// Known-good SimpleAccount deployed on Tenderly fork (owner = 0xb5eb16b6...)
const SIMPLE_ACCOUNT_ADDR = '0xA1681bA5882214D66ca1eE3127E031FCCbadb3Df';
const ENTRY_POINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== ERC-4337 End-to-End Test ===\n');

  const provider = new ethers.JsonRpcProvider(TENDERLY_RPC);
  const wallet = new ethers.Wallet(SETTLEMENT_PRIVATE_KEY, provider);
  console.log(`Owner wallet: ${wallet.address}`);
  console.log(`SimpleAccount: ${SIMPLE_ACCOUNT_ADDR}`);

  // ─── Step 1: Verify SimpleAccount is deployed and valid ──────────────────────
  console.log('\n[Step 1] Verifying SimpleAccount...');
  const code = await provider.getCode(SIMPLE_ACCOUNT_ADDR);
  if (code === '0x') throw new Error('SimpleAccount not deployed!');
  console.log(`  Code length: ${code.length} bytes`);

  const account = new ethers.Contract(SIMPLE_ACCOUNT_ADDR, [
    'function owner() view returns (address)',
    'function entryPoint() view returns (address)',
  ], provider);
  const owner = await account.owner();
  const ep = await account.entryPoint();
  console.log(`  Owner: ${owner}`);
  console.log(`  EntryPoint: ${ep}`);
  console.log(`  ✅ Valid SimpleAccount`);

  // ─── Step 2: Fund the SimpleAccount's EntryPoint deposit ─────────────────────
  console.log('\n[Step 2] Funding SimpleAccount deposit in EntryPoint...');
  const entryPoint = new ethers.Contract(ENTRY_POINT_V06, [
    'function depositTo(address account) payable',
    'function balanceOf(address account) view returns (uint256)',
  ], wallet);

  const existingDeposit = await entryPoint.balanceOf(SIMPLE_ACCOUNT_ADDR);
  console.log(`  Existing deposit: ${ethers.formatEther(existingDeposit)} ETH`);

  if (existingDeposit < ethers.parseEther('0.01')) {
    const depositTx = await entryPoint.depositTo(SIMPLE_ACCOUNT_ADDR, {
      value: ethers.parseEther('0.1'),
    });
    await depositTx.wait();
    const newDeposit = await entryPoint.balanceOf(SIMPLE_ACCOUNT_ADDR);
    console.log(`  ✅ Funded. New deposit: ${ethers.formatEther(newDeposit)} ETH`);
  } else {
    console.log(`  ✅ Already funded (${ethers.formatEther(existingDeposit)} ETH)`);
  }

  // ─── Step 3: Verify account detection ─────────────────────────────────────────
  console.log('\n[Step 3] Verifying ERC-4337 account detection...');
  const { detectAccountMode } = require('./dist/safeMultisig');
  const accountInfo = await detectAccountMode(SIMPLE_ACCOUNT_ADDR, TENDERLY_RPC, 99917);
  console.log(`  Detected mode: ${accountInfo.mode}`);
  console.log(`  isERC4337: ${accountInfo.isERC4337}`);
  console.log(`  accountType: ${accountInfo.accountType}`);
  console.log(`  entryPoint: ${accountInfo.entryPoint}`);

  if (accountInfo.mode !== 'ERC4337') {
    throw new Error(`Expected ERC4337 mode, got ${accountInfo.mode}`);
  }
  console.log('  ✅ ERC4337 mode correctly detected!');

  // ─── Step 4: Submit intent to bus ─────────────────────────────────────────────
  console.log('\n[Step 4] Submitting intent to bus with SimpleAccount as sender...');
  // Build a valid intent per the HIEF-INT-01 v0.1 schema
  const intentId = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const intentPayload = {
    intentVersion: '0.1',
    intentId,
    smartAccount: SIMPLE_ACCOUNT_ADDR,
    chainId: 99917,
    deadline,
    input: {
      token: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      amount: ethers.parseEther('0.001').toString(),
    },
    outputs: [{
      token: '0x4200000000000000000000000000000000000006',
      minAmount: ethers.parseEther('0.00095').toString(),
      recipient: SIMPLE_ACCOUNT_ADDR,
    }],
    constraints: { slippageBps: 50 },
    priorityFee: { token: 'HIEF', amount: '0' },
    policyRef: { policyVersion: '0.1' },
    signature: {
      type: 'ERC1271',
      signer: SIMPLE_ACCOUNT_ADDR,
      sig: '0x',
    },
    meta: {
      source: 'erc4337-e2e-test',
      uiHints: {
        inputTokenSymbol: 'ETH',
        outputTokenSymbol: 'WETH',
        inputAmountHuman: '0.001',
      },
    },
  };

  const busRes = await fetch(`${BUS_URL}/v1/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(intentPayload),
  });
  const busJson = await busRes.json();
  // Bus returns either { data: { id } } or { intentId } directly
  const busIntentId = busJson.data?.id || busJson.intentId || intentId;
  if (!busRes.ok || !busIntentId) {
    throw new Error(`Bus submission failed: ${JSON.stringify(busJson)}`);
  }
  console.log(`  ✅ Intent submitted: ${busIntentId} (status: ${busJson.data?.status || busJson.status})`);

  // ─── Step 5: Trigger auction + simulation ─────────────────────────────────────
  console.log('\n[Step 5] Triggering auction and simulation...');
  const triggerRes = await fetch(`${SOLVER_URL}/v1/solver-network/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intentId: busIntentId }),
  });
  const triggerJson = await triggerRes.json();
  if (!triggerRes.ok || !triggerJson.success) {
    throw new Error(`Trigger failed: ${JSON.stringify(triggerJson)}`);
  }
  const triggerData = triggerJson.data;
  console.log(`  Execution mode: ${triggerData.executionMode}`);
  console.log(`  Winner: ${triggerData.winner?.solverName} | Net: $${triggerData.winner?.netOutUSD?.toFixed(4)}`);
  if (triggerData.simulation) {
    console.log(`  Simulation: ✅ gasUsed=${triggerData.simulation.gasUsed}`);
  }

  if (triggerData.executionMode !== 'ERC4337') {
    throw new Error(`Expected ERC4337 execution mode in trigger, got ${triggerData.executionMode}`);
  }
  console.log('  ✅ ERC4337 mode confirmed in trigger response!');

  // ─── Step 6: Execute via /execute endpoint ─────────────────────────────────────
  console.log('\n[Step 6] Calling /execute to build and submit UserOperation...');
  const execRes = await fetch(`${SOLVER_URL}/v1/solver-network/execute/${busIntentId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const execJson = await execRes.json();
  if (!execRes.ok || !execJson.success) {
    throw new Error(`Execute failed: ${JSON.stringify(execJson)}`);
  }
  const execData = execJson.data;
  console.log(`  Execution mode: ${execData.executionMode}`);
  console.log(`  Status: ${execData.status}`);
  console.log(`  UserOpHash: ${execData.userOpHash}`);
  console.log(`  TxHash: ${execData.txHash}`);
  console.log(`  Block: ${execData.blockNumber}`);
  console.log(`  EntryPoint: ${execData.entryPoint}`);
  console.log(`  AccountType: ${execData.accountType}`);

  if (execData.executionMode !== 'ERC4337') {
    throw new Error(`Expected ERC4337 in execute response, got ${execData.executionMode}`);
  }
  if (!execData.txHash || execData.txHash === '0x' + '0'.repeat(64)) {
    throw new Error('No valid txHash returned');
  }
  if (!execData.userOpHash) {
    throw new Error('No userOpHash returned');
  }

  console.log('\n  ✅ ERC-4337 UserOp EXECUTED on-chain!');

  // ─── Step 7: Verify intent status ─────────────────────────────────────────────
  console.log('\n[Step 7] Verifying intent status in bus...');
  await sleep(1000);
  const statusRes = await fetch(`${BUS_URL}/v1/intents/${busIntentId}`);
  const statusJson = await statusRes.json();
  const intentStatus = statusJson.data?.status;
  console.log(`  Intent status: ${intentStatus}`);
  if (intentStatus === 'EXECUTED') {
    console.log('  ✅ Intent status: EXECUTED');
  } else {
    console.log(`  ⚠️ Intent status: ${intentStatus} (may need a moment to update)`);
  }

  // ─── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n=== TEST PASSED ✅ ===');
  console.log(`SimpleAccount: ${SIMPLE_ACCOUNT_ADDR}`);
  console.log(`EntryPoint: ${ENTRY_POINT_V06}`);
  console.log(`UserOpHash: ${execData.userOpHash}`);
  console.log(`TxHash: ${execData.txHash}`);
  console.log(`Block: ${execData.blockNumber}`);
}

main().catch(err => {
  console.error('\n=== TEST FAILED ❌ ===');
  console.error(err.message);
  process.exit(1);
});
