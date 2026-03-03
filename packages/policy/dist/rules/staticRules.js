"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HIGH_RULES = exports.CRITICAL_RULES = exports.STATIC_RULES = void 0;
exports.runStaticRules = runStaticRules;
const ethers_1 = require("ethers");
const common_1 = require("@hief/common");
// ─── R1: Deadline Not Expired ──────────────────────────────────────────────
const R1_deadline = (intent) => {
    const now = Math.floor(Date.now() / 1000);
    const passed = intent.deadline > now;
    return {
        ruleId: 'R1',
        passed,
        severity: 'CRITICAL',
        finding: passed ? undefined : {
            ruleId: 'R1',
            severity: 'CRITICAL',
            message: `Intent deadline ${intent.deadline} has expired (now=${now})`,
            field: 'intent.deadline',
        },
    };
};
// ─── R2: intentId Binding ─────────────────────────────────────────────────
const R2_intentBinding = (intent, solution) => {
    const passed = solution.intentId === intent.intentId;
    return {
        ruleId: 'R2',
        passed,
        severity: 'CRITICAL',
        finding: passed ? undefined : {
            ruleId: 'R2',
            severity: 'CRITICAL',
            message: `Solution intentId ${solution.intentId} does not match intent intentId ${intent.intentId}`,
            field: 'solution.intentId',
        },
    };
};
// ─── R3: Quote Not Expired ─────────────────────────────────────────────────
const R3_quoteExpiry = (_intent, solution) => {
    const now = Math.floor(Date.now() / 1000);
    const passed = solution.quote.validUntil > now;
    return {
        ruleId: 'R3',
        passed,
        severity: 'HIGH',
        finding: passed ? undefined : {
            ruleId: 'R3',
            severity: 'HIGH',
            message: `Solution quote expired at ${solution.quote.validUntil} (now=${now})`,
            field: 'solution.quote.validUntil',
        },
    };
};
// ─── R4: Fee Within Limit ──────────────────────────────────────────────────
const R4_feeCap = (_intent, solution) => {
    const expectedOut = BigInt(solution.quote.expectedOut);
    const fee = BigInt(solution.quote.fee);
    if (expectedOut === 0n) {
        return { ruleId: 'R4', passed: true, severity: 'HIGH' };
    }
    const feeBps = (fee * 10000n) / (expectedOut + fee);
    const passed = feeBps <= BigInt(common_1.POLICY.MAX_FEE_BPS);
    return {
        ruleId: 'R4',
        passed,
        severity: 'HIGH',
        finding: passed ? undefined : {
            ruleId: 'R4',
            severity: 'HIGH',
            message: `Fee ${feeBps}bps exceeds max ${common_1.POLICY.MAX_FEE_BPS}bps`,
            field: 'solution.quote.fee',
            actual: feeBps.toString(),
            expected: `<= ${common_1.POLICY.MAX_FEE_BPS}`,
        },
    };
};
// ─── R5: Slippage Within Limit ─────────────────────────────────────────────
const R5_slippageCap = (intent) => {
    const slippage = intent.constraints.slippageBps ?? 0;
    const passed = slippage <= common_1.POLICY.MAX_SLIPPAGE_BPS;
    return {
        ruleId: 'R5',
        passed,
        severity: 'HIGH',
        finding: passed ? undefined : {
            ruleId: 'R5',
            severity: 'HIGH',
            message: `Slippage ${slippage}bps exceeds max ${common_1.POLICY.MAX_SLIPPAGE_BPS}bps`,
            field: 'intent.constraints.slippageBps',
            actual: slippage.toString(),
            expected: `<= ${common_1.POLICY.MAX_SLIPPAGE_BPS}`,
        },
    };
};
// ─── R6: No Blacklisted Function Selectors ────────────────────────────────
const R6_noBlacklistedSelectors = (_intent, solution) => {
    const violations = [];
    for (const call of solution.executionPlan.calls) {
        if (call.data && call.data.length >= 10) {
            const selector = call.data.slice(0, 10).toLowerCase();
            if (common_1.BLACKLISTED_SELECTORS.has(selector)) {
                violations.push(`${call.to}:${selector}`);
            }
        }
    }
    const passed = violations.length === 0;
    return {
        ruleId: 'R6',
        passed,
        severity: 'CRITICAL',
        finding: passed ? undefined : {
            ruleId: 'R6',
            severity: 'CRITICAL',
            message: `Blacklisted function selectors detected: ${violations.join(', ')}`,
            field: 'solution.executionPlan.calls',
        },
    };
};
// ─── R7: No Unlimited ERC20 Approval ─────────────────────────────────────
const R7_noUnlimitedApproval = (_intent, solution) => {
    const APPROVE_SELECTOR = '0x095ea7b3';
    const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    const violations = [];
    for (const call of solution.executionPlan.calls) {
        if (!call.data || call.data.length < 10)
            continue;
        const selector = call.data.slice(0, 10).toLowerCase();
        if (selector === APPROVE_SELECTOR && call.data.length >= 138) {
            try {
                const iface = new ethers_1.ethers.Interface(['function approve(address spender, uint256 amount)']);
                const decoded = iface.decodeFunctionData('approve', call.data);
                const amount = BigInt(decoded[1].toString());
                if (amount === MAX_UINT256) {
                    violations.push(`${call.to} → unlimited approval to ${decoded[0]}`);
                }
            }
            catch {
                // Cannot decode, skip
            }
        }
    }
    const passed = violations.length === 0;
    return {
        ruleId: 'R7',
        passed,
        severity: 'HIGH',
        finding: passed ? undefined : {
            ruleId: 'R7',
            severity: 'HIGH',
            message: `Unlimited ERC20 approval detected: ${violations.join('; ')}`,
            field: 'solution.executionPlan.calls',
        },
    };
};
// ─── R8: Calls Target Known Protocols (Soft Warning) ─────────────────────
const R8_protocolWhitelist = (_intent, solution) => {
    const unknownTargets = [];
    for (const call of solution.executionPlan.calls) {
        const addr = call.to.toLowerCase();
        if (!common_1.WHITELISTED_PROTOCOLS.has(addr) && !common_1.WHITELISTED_PROTOCOLS.has(call.to)) {
            unknownTargets.push(call.to);
        }
    }
    const passed = unknownTargets.length === 0;
    return {
        ruleId: 'R8',
        passed,
        severity: 'MEDIUM',
        finding: passed ? undefined : {
            ruleId: 'R8',
            severity: 'MEDIUM',
            message: `Calls target non-whitelisted addresses: ${unknownTargets.join(', ')}`,
            field: 'solution.executionPlan.calls',
        },
    };
};
// ─── R9: No ETH Value Drain ────────────────────────────────────────────────
const R9_noEthDrain = (intent, solution) => {
    const maxSpend = BigInt(intent.constraints.maxSpend ?? '0');
    let totalValue = 0n;
    for (const call of solution.executionPlan.calls) {
        totalValue += BigInt(call.value || '0');
    }
    if (maxSpend === 0n) {
        const passed = totalValue === 0n;
        return {
            ruleId: 'R9',
            passed,
            severity: 'MEDIUM',
            finding: passed ? undefined : {
                ruleId: 'R9',
                severity: 'MEDIUM',
                message: `ETH value ${totalValue} being spent but no maxSpend constraint set`,
                field: 'intent.constraints.maxSpend',
            },
        };
    }
    const passed = totalValue <= maxSpend;
    return {
        ruleId: 'R9',
        passed,
        severity: 'HIGH',
        finding: passed ? undefined : {
            ruleId: 'R9',
            severity: 'HIGH',
            message: `Total ETH value ${totalValue} exceeds maxSpend ${maxSpend}`,
            field: 'solution.executionPlan.calls',
            actual: totalValue.toString(),
            expected: `<= ${maxSpend}`,
        },
    };
};
// ─── R10: Output Token Defined ────────────────────────────────────────────
const R10_outputDefined = (intent) => {
    const passed = intent.outputs.length > 0;
    return {
        ruleId: 'R10',
        passed,
        severity: 'CRITICAL',
        finding: passed ? undefined : {
            ruleId: 'R10',
            severity: 'CRITICAL',
            message: 'Intent has no outputs defined',
            field: 'intent.outputs',
        },
    };
};
// ─── R11: No DELEGATECALL ─────────────────────────────────────────────────
const R11_noDelegatecall = (_intent, solution) => {
    const violations = solution.executionPlan.calls
        .filter((c) => c.operation === 'DELEGATECALL')
        .map((c) => c.to);
    const passed = violations.length === 0;
    return {
        ruleId: 'R11',
        passed,
        severity: 'CRITICAL',
        finding: passed ? undefined : {
            ruleId: 'R11',
            severity: 'CRITICAL',
            message: `DELEGATECALL detected to: ${violations.join(', ')}`,
            field: 'solution.executionPlan.calls',
        },
    };
};
// ─── R12: Supported Chain ID ──────────────────────────────────────────────
const R12_chainId = (intent) => {
    const supportedChains = new Set([1, 8453, 84532, 31337]);
    const passed = supportedChains.has(intent.chainId);
    return {
        ruleId: 'R12',
        passed,
        severity: 'CRITICAL',
        finding: passed ? undefined : {
            ruleId: 'R12',
            severity: 'CRITICAL',
            message: `Unsupported chainId: ${intent.chainId}`,
            field: 'intent.chainId',
        },
    };
};
// ─── Rule Registry ────────────────────────────────────────────────────────
exports.STATIC_RULES = [
    R1_deadline,
    R2_intentBinding,
    R3_quoteExpiry,
    R4_feeCap,
    R5_slippageCap,
    R6_noBlacklistedSelectors,
    R7_noUnlimitedApproval,
    R8_protocolWhitelist,
    R9_noEthDrain,
    R10_outputDefined,
    R11_noDelegatecall,
    R12_chainId,
];
exports.CRITICAL_RULES = new Set(['R1', 'R2', 'R6', 'R10', 'R11', 'R12']);
exports.HIGH_RULES = new Set(['R3', 'R4', 'R5', 'R7']);
function runStaticRules(intent, solution) {
    const results = exports.STATIC_RULES.map((rule) => rule(intent, solution));
    const hasCriticalFailure = results.some((r) => !r.passed && exports.CRITICAL_RULES.has(r.ruleId));
    const hasHighFailure = results.some((r) => !r.passed && exports.HIGH_RULES.has(r.ruleId));
    return { results, hasCriticalFailure, hasHighFailure };
}
//# sourceMappingURL=staticRules.js.map