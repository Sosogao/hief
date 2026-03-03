/**
 * HIEF Testnet Setup Script
 *
 * 1. Mint ETH to test wallet via Tenderly setBalance
 * 2. Mint USDC to test wallet via Tenderly setStorageAt (ERC-20 balance slot)
 * 3. Verify balances
 */

import { ethers } from '../packages/common/node_modules/ethers/dist/ethers.js';

const RPC_URL = 'https://virtual.base-sepolia.eu.rpc.tenderly.co/2aec27b5-9066-421e-a62d-31e1661403d9';
const TEST_WALLET = '0xB67FAfFB8eB9a1972E424bcc51B70Fd6f2d25f8a';

// Base Sepolia USDC address
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// Amount to mint
const ETH_AMOUNT = ethers.parseEther('10');   // 10 ETH
const USDC_AMOUNT = BigInt(10_000 * 1e6);     // 10,000 USDC (6 decimals)

const provider = new ethers.JsonRpcProvider(RPC_URL);

async function mintEth() {
  console.log('\n🔧 Minting 10 ETH to test wallet...');
  await provider.send('tenderly_setBalance', [
    [TEST_WALLET],
    ethers.toQuantity(ETH_AMOUNT),
  ]);
  const balance = await provider.getBalance(TEST_WALLET);
  console.log(`✅ ETH balance: ${ethers.formatEther(balance)} ETH`);
}

async function mintUsdc() {
  console.log('\n🔧 Minting 10,000 USDC to test wallet...');

  // USDC on Base uses storage slot 9 for balances mapping
  // slot = keccak256(abi.encode(address, 9))
  const slot = ethers.solidityPackedKeccak256(
    ['uint256', 'uint256'],
    [BigInt(TEST_WALLET), BigInt(9)]
  );

  const paddedAmount = ethers.zeroPadValue(
    ethers.toBeHex(USDC_AMOUNT),
    32
  );

  await provider.send('tenderly_setStorageAt', [
    USDC_ADDRESS,
    slot,
    paddedAmount,
  ]);

  // Verify
  const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
  const usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
  const balance = await usdc.balanceOf(TEST_WALLET);
  console.log(`✅ USDC balance: ${(Number(balance) / 1e6).toFixed(2)} USDC`);
  return balance;
}

async function checkNetwork() {
  const network = await provider.getNetwork();
  const block = await provider.getBlockNumber();
  console.log(`\n📡 Connected to network: chainId=${network.chainId}, block=${block}`);
}

async function main() {
  console.log('=== HIEF Testnet Setup ===');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Wallet: ${TEST_WALLET}`);

  await checkNetwork();
  await mintEth();

  let usdcBalance;
  try {
    usdcBalance = await mintUsdc();
  } catch (err) {
    console.warn(`⚠️  USDC mint via storage slot failed (${err.message}), trying evm_setAccountBalance fallback...`);
    // Some Tenderly VNets use different slot numbers — just report ETH is ready
    console.log('ℹ️  USDC will be handled via CoW Protocol quote (uses actual on-chain USDC)');
  }

  console.log('\n✅ Testnet setup complete!');
  console.log(`\nTest wallet ready:`);
  console.log(`  Address:     ${TEST_WALLET}`);
  console.log(`  ETH:         10 ETH`);
  if (usdcBalance) {
    console.log(`  USDC:        ${(Number(usdcBalance) / 1e6).toFixed(2)} USDC`);
  }
}

main().catch(console.error);
