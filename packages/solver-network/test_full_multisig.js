/**
 * Full two-key E2E test for Safe execTransaction
 * 
 * Uses both the AI key (0xb5eb...) and a second test key to simulate
 * what MetaMask would do for the user (0x7d73...).
 * 
 * NOTE: This test uses the ACTUAL user private key from the Tenderly fork.
 * The user address 0x7d73... is funded on the fork.
 */
const { ethers } = require('ethers');
const crypto = require('crypto');

const TENDERLY_RPC = 'https://virtual.base-sepolia.eu.rpc.tenderly.co/d8ee495e-1c03-4236-9615-b4a03b52069f';
const SAFE_ADDRESS = '0x6191002739f49B97eF28fC51c66Aab11a987dC91';
const AI_KEY = '0xf2be7fd8f35f99b3838c9dc7e1bdbeccaefb9031ebd223a18c1a8e54f5bb780d';
const CHAIN_ID = 99917;
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

// The user key for 0x7d73... — this is the Tenderly test account
// We need to get this from the environment or use a known test key
const USER_KEY = process.env.USER_PRIVATE_KEY;

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) payable returns (bool success)',
];

async function main() {
  if (!USER_KEY) {
    console.error('❌ USER_PRIVATE_KEY environment variable is required');
    console.log('   Set it with: export USER_PRIVATE_KEY=0x...');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(TENDERLY_RPC);
  const aiWallet = new ethers.Wallet(AI_KEY, provider);
  const userWallet = new ethers.Wallet(USER_KEY, provider);
  const safeContract = new ethers.Contract(SAFE_ADDRESS, SAFE_ABI, provider);

  console.log('AI address:   ', aiWallet.address);
  console.log('User address: ', userWallet.address);

  const nonce = Number(await safeContract.nonce());
  console.log('Safe nonce:   ', nonce);

  const wethInterface = new ethers.Interface(['function deposit() payable']);
  const depositData = wethInterface.encodeFunctionData('deposit', []);

  const safeTx = {
    to: WETH_ADDRESS,
    value: ethers.parseEther('0.001').toString(),
    data: depositData,
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce,
  };

  const typedDataTypes = {
    SafeTx: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
  };
  const domain = { chainId: CHAIN_ID, verifyingContract: SAFE_ADDRESS };
  const message = { ...safeTx };

  // Sign with AI key (eth_sign style — signMessage adds prefix, v=31/32)
  const safeTxHash = ethers.TypedDataEncoder.hash(domain, typedDataTypes, message);
  console.log('\nsafeTxHash:', safeTxHash);

  const aiSig = await aiWallet.signMessage(ethers.getBytes(safeTxHash));
  console.log('AI sig (eth_sign):', aiSig.slice(0, 20) + '...');

  // Sign with user key (EIP-712 style — signTypedData, v=27/28)
  const userSig = await userWallet.signTypedData(domain, typedDataTypes, message);
  console.log('User sig (EIP-712):', userSig.slice(0, 20) + '...');

  // Pack signatures: sorted by signer address (ascending)
  const aiAddr = aiWallet.address.toLowerCase();
  const userAddr = userWallet.address.toLowerCase();
  
  let packedSigs;
  if (aiAddr < userAddr) {
    packedSigs = aiSig + userSig.slice(2);
  } else {
    packedSigs = userSig + aiSig.slice(2);
  }
  console.log('\nSigner order:', aiAddr < userAddr ? 'AI first, User second' : 'User first, AI second');
  console.log('Packed sigs:', packedSigs.slice(0, 30) + '...');

  // Execute
  const executor = new ethers.Wallet(AI_KEY, provider);
  const safeWithSigner = new ethers.Contract(SAFE_ADDRESS, SAFE_ABI, executor);

  console.log('\nCalling execTransaction...');
  const tx = await safeWithSigner.execTransaction(
    safeTx.to,
    BigInt(safeTx.value),
    safeTx.data,
    safeTx.operation,
    BigInt(safeTx.safeTxGas),
    BigInt(safeTx.baseGas),
    BigInt(safeTx.gasPrice),
    safeTx.gasToken,
    safeTx.refundReceiver,
    packedSigs,
    { gasLimit: 500000 }
  );
  console.log('TX submitted:', tx.hash);
  const receipt = await tx.wait();
  console.log('✅ TX confirmed! Block:', receipt.blockNumber, '| Status:', receipt.status);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
