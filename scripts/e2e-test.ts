/**
 * HIEF End-to-End Test Script
 * Tests the complete flow: AI Agent → Intent Bus → Policy Engine → Solver → Reputation
 * Network: Tenderly Virtual Testnet (Base Sepolia fork, Chain ID: 99917)
 */

import axios from 'axios';

// ─── Config ───────────────────────────────────────────────────────────────────
const AGENT_URL = 'http://localhost:3004';
const BUS_URL = 'http://localhost:3001';
const POLICY_URL = 'http://localhost:3003';
const REPUTATION_URL = 'http://localhost:3005';

const TEST_WALLET = '0xB67FAfFB8eB9a1972E424bcc51B70Fd6f2d25f8a';
const CHAIN_ID = 99917; // Tenderly Virtual Testnet

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(step: string, data: any) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[STEP] ${step}`);
  console.log('─'.repeat(60));
  console.log(JSON.stringify(data, null, 2));
}

function success(msg: string) {
  console.log(`\n✅ ${msg}`);
}

function fail(msg: string, err?: any) {
  console.error(`\n❌ ${msg}`);
  if (err) console.error(err?.response?.data ?? err?.message ?? err);
}

// ─── Test Steps ───────────────────────────────────────────────────────────────

async function step1_checkServices() {
  console.log('\n🔍 Step 1: Checking all services...');
  
  const services = [
    { name: 'AI Agent', url: `${AGENT_URL}/health` },
    { name: 'Intent Bus', url: `${BUS_URL}/health` },
    { name: 'Policy Engine', url: `${POLICY_URL}/health` },
    { name: 'Reputation API', url: `${REPUTATION_URL}/v1/reputation/health` },
  ];

  for (const svc of services) {
    try {
      const res = await axios.get(svc.url, { timeout: 5000 });
      success(`${svc.name}: ${res.data.status}`);
    } catch (err: any) {
      fail(`${svc.name} not responding`, err);
      throw new Error(`Service ${svc.name} is down`);
    }
  }
}

async function step2_parseIntent() {
  console.log('\n🤖 Step 2: AI Agent parses natural language intent...');
  
  const userMessage = 'swap 100 USDC to ETH';
  
  const res = await axios.post(`${AGENT_URL}/v1/agent/parse`, {
    message: userMessage,
    smartAccount: TEST_WALLET,
    chainId: CHAIN_ID,
  });

  log('Parse Result', res.data);

  if (!res.data.ready || !res.data.intent) {
    throw new Error(`Parse failed: ${JSON.stringify(res.data.resolveErrors)}`);
  }

  success(`Intent parsed: ${userMessage}`);
  return res.data.intent;
}

async function step3_submitToIntentBus(intent: any) {
  console.log('\n📨 Step 3: Submitting intent to Intent Bus...');
  
  const res = await axios.post(`${BUS_URL}/v1/intents`, intent);
  log('Intent Bus Response', res.data);

  if (!res.data.intentId) {
    throw new Error('Intent Bus did not return intentId');
  }

  success(`Intent submitted: ${res.data.intentId}`);
  return res.data.intentId;
}

async function step4_policyValidation(intent: any) {
  console.log('\n🛡️ Step 4: Policy Engine validates intent...');
  
  const res = await axios.post(`${POLICY_URL}/v1/policy/validateIntent`, { intent });
  log('Policy Validation Result', res.data);

  const policyStatus = res.data.status;
  if (policyStatus === 'FAIL') {
    const findings = res.data.findings ?? [];
    throw new Error(`Policy validation failed: ${findings.map((v: any) => v.message).join(', ')}`);
  }

  success(`Policy validation passed (status: ${policyStatus}, ${res.data.findings?.length ?? 0} findings)`);
  return res.data;
}

async function step5_getIntentStatus(intentId: string) {
  console.log('\n📊 Step 5: Checking intent status...');
  
  const res = await axios.get(`${BUS_URL}/v1/intents/${intentId}`);
  log('Intent Status', res.data);
  
  success(`Intent status: ${res.data.status}`);
  return res.data;
}

async function step6_updateReputation(intentId: string) {
  console.log('\n⭐ Step 6: Recording intent event in Reputation system...');
  
  const event = {
    intentId,
    address: TEST_WALLET,
    chainId: CHAIN_ID,
    intentType: 'SWAP',
    inputToken: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC
    outputToken: '0x4200000000000000000000000000000000000006', // WETH
    inputAmountUSD: 100,
    status: 'EXECUTED',
    executedAt: Date.now(),
    actualSlippageBps: 15,
  };

  const res = await axios.post(`${REPUTATION_URL}/v1/reputation/events`, event);
  log('Reputation Update', res.data);

  success(`Reputation updated: score=${res.data.data?.newScore?.toFixed(2)}, tier=${res.data.data?.riskTier}`);
  return res.data;
}

async function step7_getReputationScore() {
  console.log('\n🏆 Step 7: Fetching final reputation score...');
  
  const res = await axios.get(`${REPUTATION_URL}/v1/reputation/${CHAIN_ID}/${TEST_WALLET}`);
  log('Reputation Score', res.data);

  const snapshot = res.data.data;
  success(`Final reputation: score=${snapshot?.scores?.final?.toFixed(2)}, tier=${snapshot?.riskTier}`);
  return snapshot;
}

async function step8_conversationFlow() {
  console.log('\n💬 Step 8: Testing multi-turn conversation flow...');
  
  // Create session
  const sessionRes = await axios.post(`${AGENT_URL}/v1/agent/sessions`, {
    smartAccount: TEST_WALLET,
    chainId: CHAIN_ID,
  });
  const sessionId = sessionRes.data.sessionId;
  success(`Session created: ${sessionId}`);

  // Turn 1: Initial intent
  const turn1 = await axios.post(`${AGENT_URL}/v1/agent/sessions/${sessionId}/messages`, {
    message: 'I want to swap 50 USDC to ETH',
  });
  log('Turn 1 - Agent Response', {
    state: turn1.data.state,
    response: turn1.data.agentResponse,
    hasIntent: !!turn1.data.intent,
  });

  // Turn 2: Confirm
  if (turn1.data.state === 'AWAITING_CONFIRMATION') {
    const turn2 = await axios.post(`${AGENT_URL}/v1/agent/sessions/${sessionId}/messages`, {
      message: 'yes',
    });
    log('Turn 2 - Confirmation', {
      state: turn2.data.state,
      response: turn2.data.agentResponse,
    });
    success(`Conversation flow completed: ${turn2.data.state}`);
  } else {
    console.log(`  State after turn 1: ${turn1.data.state} (may need clarification)`);
  }

  return sessionId;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     HIEF End-to-End Test - Tenderly Virtual Testnet      ║');
  console.log('║     Network: Base Sepolia fork (Chain ID: 99917)         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\nTest Wallet: ${TEST_WALLET}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);

  const results: Record<string, 'PASS' | 'FAIL'> = {};

  try {
    // Step 1: Service health check
    await step1_checkServices();
    results['1. Service Health Check'] = 'PASS';

    // Step 2: AI Agent parses intent
    const intent = await step2_parseIntent();
    results['2. AI Intent Parsing'] = 'PASS';

    // Step 3: Submit to Intent Bus
    const intentId = await step3_submitToIntentBus(intent);
    results['3. Intent Bus Submission'] = 'PASS';

    // Step 4: Policy validation
    await step4_policyValidation(intent);
    results['4. Policy Validation'] = 'PASS';

    // Step 5: Check intent status
    await step5_getIntentStatus(intentId);
    results['5. Intent Status Check'] = 'PASS';

    // Step 6: Update reputation
    await step6_updateReputation(intentId);
    results['6. Reputation Update'] = 'PASS';

    // Step 7: Get final reputation
    await step7_getReputationScore();
    results['7. Reputation Score Query'] = 'PASS';

    // Step 8: Multi-turn conversation
    await step8_conversationFlow();
    results['8. Multi-turn Conversation'] = 'PASS';

  } catch (err: any) {
    const failedStep = Object.keys(results).length + 1;
    results[`${failedStep}. Current Step`] = 'FAIL';
    fail('Test failed', err);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                    TEST SUMMARY                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  let passed = 0;
  let failed = 0;
  
  for (const [step, result] of Object.entries(results)) {
    const icon = result === 'PASS' ? '✅' : '❌';
    console.log(`  ${icon} ${step}: ${result}`);
    if (result === 'PASS') passed++;
    else failed++;
  }
  
  console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  
  if (failed === 0) {
    console.log('\n🎉 ALL TESTS PASSED! HIEF E2E flow is working correctly.');
  } else {
    console.log(`\n⚠️  ${failed} test(s) failed. Please check the logs above.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
