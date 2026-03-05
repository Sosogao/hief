/**
 * Diagnostic: test Safe signature verification
 * 
 * We have:
 * - AI key: 0xb5eb... (owner 1)
 * - User key: 0x7d73... (owner 2)
 * 
 * The Safe contract uses execTransaction with packed signatures.
 * Let's verify our signature packing is correct.
 */
const { ethers } = require('ethers');

const TENDERLY_RPC = 'https://virtual.base-sepolia.eu.rpc.tenderly.co/d8ee495e-1c03-4236-9615-b4a03b52069f';
const SAFE_ADDRESS = '0x6191002739f49B97eF28fC51c66Aab11a987dC91';
const AI_KEY = '0xf2be7fd8f35f99b3838c9dc7e1bdbeccaefb9031ebd223a18c1a8e54f5bb780d';
const CHAIN_ID = 99917;
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) payable returns (bool success)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(TENDERLY_RPC);
  const aiWallet = new ethers.Wallet(AI_KEY, provider);
  const safeContract = new ethers.Contract(SAFE_ADDRESS, SAFE_ABI, provider);
  
  console.log('AI address:', aiWallet.address);
  
  // Get current nonce
  const nonce = Number(await safeContract.nonce());
  console.log('Safe nonce:', nonce);
  
  const owners = await safeContract.getOwners();
  const threshold = Number(await safeContract.getThreshold());
  console.log('Owners:', owners);
  console.log('Threshold:', threshold);
  
  // Build Safe TX
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
    nonce: nonce,
  };
  
  // Method 1: Manual EIP-712 hash computation (our current approach)
  const SAFE_TX_TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes(
      'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)'
    )
  );
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encodedTx = ethers.keccak256(
    coder.encode(
      ['bytes32','address','uint256','bytes32','uint8','uint256','uint256','uint256','address','address','uint256'],
      [
        SAFE_TX_TYPEHASH,
        safeTx.to,
        BigInt(safeTx.value),
        ethers.keccak256(safeTx.data),
        safeTx.operation,
        BigInt(safeTx.safeTxGas),
        BigInt(safeTx.baseGas),
        BigInt(safeTx.gasPrice),
        safeTx.gasToken,
        safeTx.refundReceiver,
        BigInt(safeTx.nonce),
      ]
    )
  );
  const DOMAIN_SEPARATOR_TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes('EIP712Domain(uint256 chainId,address verifyingContract)')
  );
  const domainSeparator = ethers.keccak256(
    coder.encode(
      ['bytes32','uint256','address'],
      [DOMAIN_SEPARATOR_TYPEHASH, BigInt(CHAIN_ID), SAFE_ADDRESS]
    )
  );
  const manualHash = ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes('\x19\x01'),
      ethers.getBytes(domainSeparator),
      ethers.getBytes(encodedTx),
    ])
  );
  console.log('\nManual safeTxHash:', manualHash);
  
  // Method 2: ethers.js signTypedData (what MetaMask uses)
  const typedData = {
    domain: {
      chainId: CHAIN_ID.toString(),
      verifyingContract: SAFE_ADDRESS,
    },
    types: {
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
    },
    message: {
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data,
      operation: safeTx.operation,
      safeTxGas: safeTx.safeTxGas,
      baseGas: safeTx.baseGas,
      gasPrice: safeTx.gasPrice,
      gasToken: safeTx.gasToken,
      refundReceiver: safeTx.refundReceiver,
      nonce: safeTx.nonce,
    },
  };
  
  // ethers.TypedDataEncoder.hash computes the EIP-712 hash
  const ethersHash = ethers.TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
  console.log('Ethers TypedData hash:', ethersHash);
  console.log('Hashes match:', manualHash === ethersHash);
  
  // Sign with AI key using signMessage (eth_sign style, v+4)
  const aiSigEthSign = await aiWallet.signMessage(ethers.getBytes(manualHash));
  console.log('\nAI eth_sign signature:', aiSigEthSign.slice(0, 20) + '...');
  
  // Sign with AI key using signTypedData (EIP-712 style, v=27/28)
  const aiSigTypedData = await aiWallet.signTypedData(typedData.domain, typedData.types, typedData.message);
  console.log('AI signTypedData signature:', aiSigTypedData.slice(0, 20) + '...');
  
  // Verify signatures
  const recoveredFromEthSign = ethers.recoverAddress(
    ethers.hashMessage(ethers.getBytes(manualHash)),
    aiSigEthSign
  );
  console.log('\nRecovered from eth_sign:', recoveredFromEthSign);
  console.log('Matches AI address:', recoveredFromEthSign.toLowerCase() === aiWallet.address.toLowerCase());
  
  const recoveredFromTypedData = ethers.recoverAddress(ethersHash, aiSigTypedData);
  console.log('Recovered from signTypedData:', recoveredFromTypedData);
  console.log('Matches AI address:', recoveredFromTypedData.toLowerCase() === aiWallet.address.toLowerCase());
}

main().catch(console.error);
