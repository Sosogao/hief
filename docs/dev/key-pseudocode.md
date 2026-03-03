# HIEF 关键算法伪代码 (v0.1)

本文档提供了 HIEF 核心哈希算法的参考实现伪代码，以确保跨语言实现的一致性。

## 1. `intentHash` (EIP-712)

```typescript
import { ethers, keccak256, AbiCoder } from 'ethers';

// 假设 intent 对象已按 HIEF-INT-01 规范准备好
async function computeIntentHash(intent: HIEFIntent, chainId: number): Promise<string> {

    const domain = {
        name: 'HIEF',
        version: '0.1',
        chainId: chainId,
        verifyingContract: '0x0000000000000000000000000000000000000000'
    };

    const types = {
        InputAsset: [
            { name: 'token', type: 'address' },
            { name: 'amount', type: 'uint256' }
        ],
        Constraints: [
            { name: 'slippageBps', type: 'uint32' },
            { name: 'maxSpend', type: 'uint256' },
            { name: 'nonceSalt', type: 'bytes32' }
        ],
        PriorityFee: [
            { name: 'token', type: 'bytes32' },
            { name: 'amount', type: 'uint256' }
        ],
        PolicyRef: [
            { name: 'policyVersion', type: 'bytes32' },
            { name: 'policyHash', type: 'bytes32' }
        ],
        ReputationSnapshotRef: [
            { name: 'refType', type: 'bytes32' },
            { name: 'refValue', type: 'bytes32' }
        ],
        HIEFIntent: [
            { name: 'intentVersion', type: 'bytes32' },
            { name: 'intentId', type: 'bytes32' },
            { name: 'smartAccount', type: 'address' },
            { name: 'chainId', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
            { name: 'input', type: 'InputAsset' },
            { name: 'outputsHash', type: 'bytes32' },
            { name: 'constraints', type: 'Constraints' },
            { name: 'priorityFee', type: 'PriorityFee' },
            { name: 'policyRef', type: 'PolicyRef' },
            { name: 'reputationSnapshotRef', type: 'ReputationSnapshotRef' },
            { name: 'extensionsHash', type: 'bytes32' }
        ]
    };

    const outputsHash = computeOutputsHash(intent.outputs, intent.smartAccount);
    const extensionsHash = computeExtensionsHash(intent.extensions);

    const value = {
        intentVersion: keccak256(ethers.toUtf8Bytes('0.1')),
        intentId: intent.intentId,
        smartAccount: intent.smartAccount,
        chainId: intent.chainId,
        deadline: intent.deadline,
        input: intent.input,
        outputsHash: outputsHash,
        constraints: {
            slippageBps: intent.constraints.slippageBps ?? 0,
            maxSpend: intent.constraints.maxSpend ?? '0',
            nonceSalt: intent.constraints.nonceSalt ?? ethers.ZeroHash
        },
        priorityFee: {
            token: keccak256(ethers.toUtf8Bytes(intent.priorityFee.token)),
            amount: intent.priorityFee.amount
        },
        policyRef: {
            policyVersion: keccak256(ethers.toUtf8Bytes(intent.policyRef.policyVersion)),
            policyHash: intent.policyRef.policyHash ?? ethers.ZeroHash
        },
        reputationSnapshotRef: {
            refType: keccak256(ethers.toUtf8Bytes(intent.reputationSnapshotRef.type)),
            refValue: keccak256(ethers.toUtf8Bytes(intent.reputationSnapshotRef.value))
        },
        extensionsHash: extensionsHash
    };

    // 使用 Ethers.js 的 TypedDataEncoder 来计算最终哈希
    return ethers.TypedDataEncoder.hash(domain, types, value);
}

function computeOutputsHash(outputs: OutputConstraint[], smartAccount: string): string {
    const coder = AbiCoder.defaultAbiCoder();
    const itemHashes = outputs.map(o => {
        return keccak256(coder.encode(
            ['address', 'uint256', 'address'],
            [o.token, o.minAmount, o.recipient ?? smartAccount]
        ));
    });
    return keccak256(ethers.concat(itemHashes));
}

function computeExtensionsHash(extensions: object | undefined): string {
    if (!extensions || Object.keys(extensions).length === 0) {
        return ethers.ZeroHash;
    }
    // 需要一个 JCS (JSON Canonicalization Scheme) 库
    const canonicalString = jcs.canonicalize(extensions);
    return keccak256(ethers.toUtf8Bytes(canonicalString));
}
```

## 2. `planHash`

`planHash` 用于确保从 Policy 验证到 Safe 执行过程中的一致性。

```typescript
function computePlanHash(solution: HIEFSolution, intentHash: string): string {
    const coder = AbiCoder.defaultAbiCoder();

    const callHashes = solution.executionPlan.calls.map(c => {
        return keccak256(coder.encode(
            ['address', 'uint256', 'bytes'],
            [c.to, c.value, c.data]
        ));
    });
    const callsHash = keccak256(ethers.concat(callHashes));

    return keccak256(coder.encode(
        ['bytes32', 'bytes32', 'bytes32'],
        [callsHash, intentHash, solution.solutionId]
    ));
}
```

## 3. Diff Engine (核心逻辑)

Diff 引擎是 Policy 的关键，用于比较模拟前后的状态。

```typescript
async function runDiffEngine(provider: ethers.JsonRpcProvider, smartAccount: string, plan: ExecutionPlan): Promise<ExecutionDiff> {

    // 1. 获取模拟前状态
    const balanceBefore = await provider.getBalance(smartAccount);
    const tokenBalancesBefore = await getTokenBalances(provider, smartAccount, [USDC, WETH]);
    const allowancesBefore = await getTokenAllowances(provider, smartAccount, [ROUTER]);

    // 2. 模拟执行 (使用 Anvil/Hardhat fork)
    // `impersonateAccount` + `sendTransaction`
    const txReceipt = await executePlanOnFork(provider, smartAccount, plan);

    // 3. 获取模拟后状态
    const balanceAfter = await provider.getBalance(smartAccount);
    const tokenBalancesAfter = await getTokenBalances(provider, smartAccount, [USDC, WETH]);
    const allowancesAfter = await getTokenAllowances(provider, smartAccount, [ROUTER]);

    // 4. 计算差异
    const tokenChanges = calculateTokenDeltas(tokenBalancesBefore, tokenBalancesAfter);
    const allowanceChanges = calculateAllowanceDeltas(allowancesBefore, allowancesAfter);

    return {
        tokenChanges,
        allowanceChanges,
        safeConfigChanged: false // 还需要检查 Safe owner/threshold 变更
    };
}
```
