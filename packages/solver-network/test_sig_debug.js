const { ethers } = require('ethers');

const TENDERLY_RPC = 'https://virtual.base-sepolia.eu.rpc.tenderly.co/d8ee495e-1c03-4236-9615-b4a03b52069f';
const SAFE_ADDRESS = '0x6191002739f49B97eF28fC51c66Aab11a987dC91';
const AI_KEY = '0xf2be7fd8f35f99b3838c9dc7e1bdbeccaefb9031ebd223a18c1a8e54f5bb780d';
const USER_KEY = '0x51e9b757c77737a5f2a72e49ad624953eeb5110aeda7c9bbf15d9ec6307bd7b7';
const CHAIN_ID = 99917;
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function domainSeparator() view returns (bytes32)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) payable returns (bool success)',
];

async function tryExec(label, safeWithSigner, safeTx, packedSigs) {
  try {
    const tx = await safeWithSigner.execTransaction(
      safeTx.to, BigInt(safeTx.value), safeTx.data, safeTx.operation,
      BigInt(safeTx.safeTxGas), BigInt(safeTx.baseGas), BigInt(safeTx.gasPrice),
      safeTx.gasToken, safeTx.refundReceiver, packedSigs,
      { gasLimit: 500000 }
    );
    const receipt = await tx.wait();
    console.log(`  ✅ ${label} SUCCESS! txHash: ${tx.hash} | status: ${receipt.status}`);
    return true;
  } catch (e) {
    const msg = e.message.slice(0, 120);
    console.log(`  ❌ ${label} FAILED: ${msg}`);
    return false;
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(TENDERLY_RPC);
  const aiWallet = new ethers.Wallet(AI_KEY, provider);
  const userWallet = new ethers.Wallet(USER_KEY, provider);
  const safeContract = new ethers.Contract(SAFE_ADDRESS, SAFE_ABI, provider);
  const safeWithAI = new ethers.Contract(SAFE_ADDRESS, SAFE_ABI, aiWallet);

  console.log('AI:  ', aiWallet.address);
  console.log('User:', userWallet.address);

  const nonce = Number(await safeContract.nonce());
  const owners = await safeContract.getOwners();
  const threshold = Number(await safeContract.getThreshold());
  const domainSep = await safeContract.domainSeparator();
  console.log('Nonce:', nonce, '| Threshold:', threshold);
  console.log('Owners:', owners);
  console.log('Domain separator from contract:', domainSep);

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

  // Get the hash directly from the contract
  const contractHash = await safeContract.getTransactionHash(
    safeTx.to, BigInt(safeTx.value), safeTx.data, safeTx.operation,
    BigInt(safeTx.safeTxGas), BigInt(safeTx.baseGas), BigInt(safeTx.gasPrice),
    safeTx.gasToken, safeTx.refundReceiver, BigInt(safeTx.nonce)
  );
  console.log('\nHash from contract.getTransactionHash():', contractHash);

  // Our computed hash
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
  const ourHash = ethers.TypedDataEncoder.hash(domain, typedDataTypes, safeTx);
  console.log('Our computed hash:              ', ourHash);
  console.log('Hashes match:', contractHash === ourHash);

  // Sort addresses
  const aiAddr = aiWallet.address.toLowerCase();
  const userAddr = userWallet.address.toLowerCase();
  const firstAddr = aiAddr < userAddr ? aiWallet : userWallet;
  const secondAddr = aiAddr < userAddr ? userWallet : aiWallet;
  console.log('\nSorted order: first =', firstAddr.address, '| second =', secondAddr.address);

  // Try combination 1: both signTypedData (EIP-712, v=27/28)
  console.log('\n--- Test 1: Both signTypedData (EIP-712) ---');
  const sig1_first = await firstAddr.signTypedData(domain, typedDataTypes, safeTx);
  const sig1_second = await secondAddr.signTypedData(domain, typedDataTypes, safeTx);
  await tryExec('Both EIP-712', safeWithAI, safeTx, sig1_first + sig1_second.slice(2));

  // Try combination 2: both signMessage (eth_sign, v=31/32)
  console.log('\n--- Test 2: Both signMessage (eth_sign) ---');
  const sig2_first = await firstAddr.signMessage(ethers.getBytes(contractHash));
  const sig2_second = await secondAddr.signMessage(ethers.getBytes(contractHash));
  await tryExec('Both eth_sign', safeWithAI, safeTx, sig2_first + sig2_second.slice(2));

  // Try combination 3: first=EIP-712, second=eth_sign
  console.log('\n--- Test 3: First=EIP-712, Second=eth_sign ---');
  const sig3_first = await firstAddr.signTypedData(domain, typedDataTypes, safeTx);
  const sig3_second = await secondAddr.signMessage(ethers.getBytes(contractHash));
  await tryExec('First EIP-712 + Second eth_sign', safeWithAI, safeTx, sig3_first + sig3_second.slice(2));

  // Try combination 4: first=eth_sign, second=EIP-712
  console.log('\n--- Test 4: First=eth_sign, Second=EIP-712 ---');
  const sig4_first = await firstAddr.signMessage(ethers.getBytes(contractHash));
  const sig4_second = await secondAddr.signTypedData(domain, typedDataTypes, safeTx);
  await tryExec('First eth_sign + Second EIP-712', safeWithAI, safeTx, sig4_first + sig4_second.slice(2));
}

main().catch(console.error);
