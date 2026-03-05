"use strict";
/**
 * safeMultisig.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Safe Multisig integration for HIEF Solver Network.
 *
 * Responsibilities:
 *  1. detectAccountMode()  — query chain to determine if an address is a Safe
 *                            with threshold ≥ 2 (MULTISIG) or a plain EOA/1-of-1 (DIRECT)
 *  2. proposeSafeMultisig() — after simulation, build & submit a Safe Transaction
 *                             to the Safe Transaction Service so co-signers can approve
 *
 * Execution Mode Logic:
 *   - If smartAccount has Safe threshold ≥ 2  → MULTISIG mode
 *   - Otherwise (EOA, AA wallet, threshold=1) → DIRECT mode (existing flow)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectAccountMode = detectAccountMode;
exports.proposeSafeMultisig = proposeSafeMultisig;
const ethers_1 = require("ethers");
// ─── Constants ────────────────────────────────────────────────────────────────
/** Minimal Safe ABI — only the methods we need */
const SAFE_ABI = [
    'function getThreshold() view returns (uint256)',
    'function getOwners() view returns (address[])',
    'function nonce() view returns (uint256)',
];
/** Safe Transaction Service URLs by chainId */
const SAFE_TX_SERVICE = {
    1: 'https://safe-transaction-mainnet.safe.global',
    8453: 'https://safe-transaction-base.safe.global',
    84532: 'https://safe-transaction-base-sepolia.safe.global',
    99917: 'https://safe-transaction-base-sepolia.safe.global', // Tenderly fork → use Base Sepolia service
};
/** Safe UI base URL for signing */
const SAFE_UI_URL = 'https://app.safe.global';
// ─── Account Mode Detection ───────────────────────────────────────────────────
/**
 * Detect whether an address is a Safe multisig (threshold ≥ 2) or a direct account.
 * Uses eth_getCode to check if the address is a contract, then calls getThreshold().
 */
async function detectAccountMode(address, rpcUrl, chainId) {
    const provider = new ethers_1.ethers.JsonRpcProvider(rpcUrl);
    try {
        // Check if address is a contract
        const code = await provider.getCode(address);
        if (code === '0x' || code === '') {
            // Plain EOA
            return { address, mode: 'DIRECT', threshold: 0, owners: [], isSafe: false };
        }
        // Try to call Safe methods — if it fails, it's not a Safe
        const safeContract = new ethers_1.ethers.Contract(address, SAFE_ABI, provider);
        let threshold;
        let owners;
        try {
            [threshold, owners] = await Promise.all([
                safeContract.getThreshold(),
                safeContract.getOwners(),
            ]);
        }
        catch {
            // Contract exists but is not a Safe (e.g., ERC-4337 smart account)
            return { address, mode: 'DIRECT', threshold: 1, owners: [], isSafe: false };
        }
        const thresholdNum = Number(threshold);
        const mode = thresholdNum >= 2 ? 'MULTISIG' : 'DIRECT';
        console.log(`[SafeMultisig] Account ${address.slice(0, 10)}... detected: Safe | threshold=${thresholdNum} | owners=${owners.length} | mode=${mode}`);
        return {
            address,
            mode,
            threshold: thresholdNum,
            owners: owners,
            isSafe: true,
        };
    }
    catch (err) {
        console.warn(`[SafeMultisig] Could not detect account mode for ${address}: ${err.message}`);
        // Default to DIRECT on error
        return { address, mode: 'DIRECT', threshold: 0, owners: [], isSafe: false };
    }
}
// ─── Safe Transaction Builder ─────────────────────────────────────────────────
/**
 * Build a minimal Safe transaction for a WETH-wrap (ETH→WETH) settlement.
 * In production this would be built from the winning solver's ExecutionPlan.
 */
function buildSafeTxData(to, value, data, nonce) {
    return {
        to,
        value,
        data,
        operation: 0, // CALL
        safeTxGas: '0',
        baseGas: '0',
        gasPrice: '0',
        gasToken: ethers_1.ethers.ZeroAddress,
        refundReceiver: ethers_1.ethers.ZeroAddress,
        nonce,
    };
}
/**
 * Compute the EIP-712 Safe transaction hash.
 */
function computeSafeTxHash(safeTx, safeAddress, chainId) {
    const SAFE_TX_TYPEHASH = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)'));
    const coder = ethers_1.ethers.AbiCoder.defaultAbiCoder();
    const encodedTx = ethers_1.ethers.keccak256(coder.encode(['bytes32', 'address', 'uint256', 'bytes32', 'uint8', 'uint256', 'uint256', 'uint256', 'address', 'address', 'uint256'], [
        SAFE_TX_TYPEHASH,
        safeTx.to,
        BigInt(safeTx.value),
        ethers_1.ethers.keccak256(safeTx.data),
        safeTx.operation,
        BigInt(safeTx.safeTxGas),
        BigInt(safeTx.baseGas),
        BigInt(safeTx.gasPrice),
        safeTx.gasToken,
        safeTx.refundReceiver,
        BigInt(safeTx.nonce),
    ]));
    const DOMAIN_SEPARATOR_TYPEHASH = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('EIP712Domain(uint256 chainId,address verifyingContract)'));
    const domainSeparator = ethers_1.ethers.keccak256(coder.encode(['bytes32', 'uint256', 'address'], [DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), safeAddress]));
    return ethers_1.ethers.keccak256(ethers_1.ethers.concat([
        ethers_1.ethers.toUtf8Bytes('\x19\x01'),
        ethers_1.ethers.getBytes(domainSeparator),
        ethers_1.ethers.getBytes(encodedTx),
    ]));
}
// ─── Safe Proposal Submission ─────────────────────────────────────────────────
/**
 * Propose a Safe multisig transaction to the Safe Transaction Service.
 * The AI (HIEF Solver) acts as the proposer and signs the safeTxHash.
 * Co-signers can then approve via the Safe UI.
 */
async function proposeSafeMultisig(params) {
    const { safeAddress, chainId, rpcUrl, proposerPrivateKey, to, value, data, intentId } = params;
    const provider = new ethers_1.ethers.JsonRpcProvider(rpcUrl);
    const proposerWallet = new ethers_1.ethers.Wallet(proposerPrivateKey, provider);
    const safeContract = new ethers_1.ethers.Contract(safeAddress, SAFE_ABI, provider);
    // Fetch current nonce from Safe contract
    const nonce = Number(await safeContract.nonce());
    // Build Safe transaction
    const safeTx = buildSafeTxData(to, value, data, nonce);
    // Compute EIP-712 hash
    const safeTxHash = computeSafeTxHash(safeTx, safeAddress, chainId);
    // Sign the safeTxHash with the proposer's key
    const signature = await proposerWallet.signMessage(ethers_1.ethers.getBytes(safeTxHash));
    // Determine Safe Transaction Service URL
    const serviceUrl = SAFE_TX_SERVICE[chainId] || SAFE_TX_SERVICE[84532];
    // Submit to Safe Transaction Service
    const payload = {
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
        contractTransactionHash: safeTxHash,
        sender: proposerWallet.address,
        signature,
        origin: `HIEF Intent ${intentId.slice(0, 16)}`,
    };
    try {
        const resp = await fetch(`${serviceUrl}/api/v1/safes/${safeAddress}/multisig-transactions/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            const errText = await resp.text();
            console.warn(`[SafeMultisig] Safe TX Service returned ${resp.status}: ${errText}`);
            // Don't throw — we still have the safeTxHash for the UI
        }
        else {
            console.log(`[SafeMultisig] ✅ Proposal submitted to Safe TX Service | safeTxHash: ${safeTxHash.slice(0, 16)}...`);
        }
    }
    catch (err) {
        console.warn(`[SafeMultisig] Could not reach Safe TX Service: ${err.message}. safeTxHash still valid for manual signing.`);
    }
    // Build the Safe UI signing URL
    const networkSlug = chainId === 8453 ? 'base' : chainId === 84532 ? 'basesep' : 'basesep';
    const signingUrl = `${SAFE_UI_URL}/transactions/tx?safe=${networkSlug}:${safeAddress}&id=multisig_${safeAddress}_${safeTxHash}`;
    return {
        safeTxHash,
        safeAddress,
        threshold: 0, // Will be filled by caller
        nonce,
        proposedAt: Math.floor(Date.now() / 1000),
        safeServiceUrl: serviceUrl,
        signingUrl,
    };
}
