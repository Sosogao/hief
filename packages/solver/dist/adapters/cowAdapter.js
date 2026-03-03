"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCowQuote = getCowQuote;
exports.buildSolutionFromCowQuote = buildSolutionFromCowQuote;
exports.submitCowOrder = submitCowOrder;
const axios_1 = __importDefault(require("axios"));
const ethers_1 = require("ethers");
// CoW Protocol API endpoints
const COW_API_BASE = {
    1: 'https://api.cow.fi/mainnet',
    8453: 'https://api.cow.fi/base',
    84532: 'https://api.cow.fi/base_sepolia',
    31337: 'https://api.cow.fi/mainnet', // local dev uses mainnet
};
// CoW Settlement contract addresses
const COW_SETTLEMENT = {
    1: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    8453: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    84532: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    31337: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
};
// CoW Vault Relayer (for token approvals)
const COW_VAULT_RELAYER = {
    1: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
    8453: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
    84532: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
    31337: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
};
/**
 * Get a quote from CoW Protocol for the given intent.
 */
async function getCowQuote(intent) {
    const apiBase = COW_API_BASE[intent.chainId];
    if (!apiBase) {
        console.log(`[COW] No API endpoint for chainId ${intent.chainId}`);
        return null;
    }
    try {
        const response = await axios_1.default.post(`${apiBase}/api/v1/quote`, {
            sellToken: intent.input.token,
            buyToken: intent.outputs[0].token,
            sellAmountBeforeFee: intent.input.amount,
            from: intent.smartAccount,
            receiver: intent.smartAccount,
            appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
            appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
            partiallyFillable: false,
            sellTokenBalance: 'erc20',
            buyTokenBalance: 'erc20',
            kind: 'sell',
            validTo: intent.deadline,
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
        });
        const { quote, id } = response.data;
        return {
            sellToken: quote.sellToken,
            buyToken: quote.buyToken,
            sellAmount: quote.sellAmount,
            buyAmount: quote.buyAmount,
            feeAmount: quote.feeAmount,
            validTo: quote.validTo,
            appData: quote.appData,
            kind: quote.kind,
            partiallyFillable: quote.partiallyFillable,
            quoteId: id,
        };
    }
    catch (err) {
        if (err.response?.status === 400) {
            console.log(`[COW] Quote request failed: ${JSON.stringify(err.response.data)}`);
        }
        else {
            console.error('[COW] Quote API error:', err.message);
        }
        return null;
    }
}
/**
 * Build a HIEF Solution from a CoW Protocol quote.
 * The execution plan includes the approve + settlement calls.
 */
function buildSolutionFromCowQuote(intent, quote, solverId) {
    const settlementAddress = COW_SETTLEMENT[intent.chainId];
    const vaultRelayer = COW_VAULT_RELAYER[intent.chainId];
    // Build the CoW order struct for signing
    const orderData = {
        sellToken: quote.sellToken,
        buyToken: quote.buyToken,
        receiver: intent.smartAccount,
        sellAmount: quote.sellAmount,
        buyAmount: quote.buyAmount,
        validTo: quote.validTo,
        appData: quote.appData,
        feeAmount: quote.feeAmount,
        kind: quote.kind,
        partiallyFillable: quote.partiallyFillable,
        sellTokenBalance: 'erc20',
        buyTokenBalance: 'erc20',
    };
    // Build execution calls:
    // 1. Approve vault relayer to spend sell token
    // 2. Sign and submit order to CoW settlement
    const erc20Iface = new ethers_1.ethers.Interface([
        'function approve(address spender, uint256 amount)',
    ]);
    const cowSettlementIface = new ethers_1.ethers.Interface([
        'function setPreSignature(bytes calldata orderUid, bool signed)',
    ]);
    // Encode approve call (approve exact amount, not unlimited)
    const approveCalldata = erc20Iface.encodeFunctionData('approve', [
        vaultRelayer,
        BigInt(quote.sellAmount) + BigInt(quote.feeAmount),
    ]);
    // Encode pre-sign call (placeholder orderUid - will be set after order submission)
    // In production, this would be the actual order UID from CoW API
    const orderUid = ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(56)); // 56 bytes = orderUid format
    const preSignCalldata = cowSettlementIface.encodeFunctionData('setPreSignature', [
        orderUid,
        true,
    ]);
    const solutionId = ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32));
    const intentHash = ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32)); // Will be computed properly in production
    return {
        solutionVersion: '0.1',
        solutionId,
        intentId: intent.intentId,
        intentHash,
        solverId,
        executionPlan: {
            calls: [
                {
                    to: quote.sellToken,
                    value: '0',
                    data: approveCalldata,
                    operation: 'CALL',
                },
                {
                    to: settlementAddress,
                    value: '0',
                    data: preSignCalldata,
                    operation: 'CALL',
                },
            ],
        },
        quote: {
            expectedOut: quote.buyAmount,
            fee: quote.feeAmount,
            validUntil: quote.validTo,
        },
        stakeSnapshot: { amount: '0' },
        signature: {
            type: 'EIP712_EOA',
            signer: solverId,
            sig: '0x', // Will be signed by solver before submission
        },
        meta: {
            protocol: 'cow',
            quoteId: quote.quoteId,
            orderData,
        },
    };
}
/**
 * Submit a CoW order after Safe execution.
 * Returns the order UID.
 */
async function submitCowOrder(intent, orderData, signature) {
    const apiBase = COW_API_BASE[intent.chainId];
    if (!apiBase)
        return null;
    try {
        const response = await axios_1.default.post(`${apiBase}/api/v1/orders`, {
            ...orderData,
            signature,
            signingScheme: 'presign',
            from: intent.smartAccount,
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
        });
        return response.data; // Returns order UID
    }
    catch (err) {
        console.error('[COW] Order submission failed:', err.response?.data || err.message);
        return null;
    }
}
//# sourceMappingURL=cowAdapter.js.map