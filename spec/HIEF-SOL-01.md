# HIEF-SOL-01：HIEF Solution 对象与绑定规范 (v0.1)

- **状态**：Draft
- **版本**：0.1
- **依赖**：HIEF-INT-01 v0.1
- **目标**：定义 Solver 针对某个 Intent 提供的可执行方案（Solution）的标准结构、哈希绑定规则与签名规范，使 Solution 能被 Policy 验证并安全映射为 Smart Account（如 Safe）可执行交易。

## 1. 术语

- **Solution**：针对特定 Intent 的执行路径建议（how）。
- **ExecutionPlan**：将被 Smart Account 执行的一组 calls。
- **Quote**：Solver 对该执行路径给出的经济承诺（预期输出、费用、有效期）。
- **solutionHash**：Solution 的规范性哈希。
- **Bound Solution**：与某个 `intentHash` 强绑定的 Solution。

## 2. 设计原则

1.  **强绑定原则**
    Solution MUST 与 `intentHash` 绑定，禁止“替换目标意图”。
2.  **执行可复现原则**
    Solution MUST 提供完整 `ExecutionPlan`，Policy 可在 Fork 环境中重放。
3.  **经济承诺可验证原则**
    `Quote` MUST 明确 `expectedOut` 与有效期。
4.  **执行账户无权篡改原则**
    Adapter 在映射到 Safe 时，不得修改 `executionPlan` 的核心字段。

## 3. Solution 对象（JSON）

Solution MUST 是一个 JSON 对象，包含：

- `solutionVersion` (MUST)：固定 `"0.1"`
- `solutionId` (MUST)：0x32bytes
- `intentId` (MUST)
- `intentHash` (MUST)
- `solverId` (MUST)
- `executionPlan` (MUST)
- `quote` (MUST)
- `stakeSnapshot` (MUST)
- `simulationRef` (SHOULD)
- `meta` (MAY，不进入 hash)
- `signature` (MUST)

## 4. ExecutionPlan

### 4.1 结构

```json
"executionPlan": {
    "calls": [
        {
            "to": "0x...",
            "value": "0",
            "data": "0x...",
            "operation": "CALL"
        }
    ]
}
```

### 4.2 规范性要求

- `calls` MUST 为数组，长度 ≥ 1
- `operation` MUST 为 `"CALL"`（v0.1 禁止 DELEGATECALL）
- `value` MUST 为字符串十进制整数
- `data` MUST 为 0x hex

### 4.3 安全约束（v0.1 Policy MUST 校验）

- 禁止出现 DELEGATECALL
- 禁止修改 Safe owner / threshold
- 禁止调用 Safe `execTransaction` 自身
- 禁止调用未知高风险 selector（由 Policy rulebook 决定）

## 5. Quote 对象

```json
"quote": {
    "expectedOut": "250000000000000000",
    "fee": "1000000",
    "validUntil": 1777777700
}
```

字段说明：

- `expectedOut` (MUST)：最终输出资产数量（字符串整数）
- `fee` (MUST)：Solver 报价费用（字符串整数）
- `validUntil` (MUST)：unix timestamp

### 5.1 经济语义

- Policy MUST 校验 `validUntil` >= now
- Policy SHOULD 校验 `expectedOut` ≥ `intent.outputs[].minAmount`
- Solver 若在 `validUntil` 后被选中，Solution MUST 被视为失效

## 6. StakeSnapshot

```json
"stakeSnapshot": {
    "amount": "1000000000000000000000",
    "blockNumber": 12345678
}
```

字段说明：

- `amount` (MUST)：Solver 在某一时间点的质押数量
- `blockNumber` (SHOULD)：快照区块

v0.1 允许 `stakeSnapshot` 为“声明性字段”，v1 可链上强校验。

## 7. simulationRef（可选）

```json
"simulationRef": {
    "type": "tenderly",
    "value": "sim-abc-123"
}
```

用途：

- 指向可复现的模拟结果
- 用于审计与争议解决

Policy MAY 忽略 `simulationRef`，自行重新模拟。

## 8. solutionHash 计算规范

### 8.1 必须进入 Hash 的字段

`solutionHash` MUST 覆盖：

- `solutionVersion`
- `solutionId`
- `intentId`
- `intentHash`
- `solverId`
- `executionPlan.calls`
- `quote`
- `stakeSnapshot`
- `simulationRef`
- `extensions`（若存在）

`meta` MUST NOT 进入 hash。

### 8.2 推荐 EIP-712 Typed Data

**Domain**：

- `name`: `"HIEF-SOLUTION"`
- `version`: `"0.1"`
- `chainId`: 与 `intent.chainId` 相同
- `verifyingContract`: `0x0000000000000000000000000000000000000000`

### 8.3 Typed Data 结构（规范性）

```solidity
struct Call {
    address to;
    uint256 value;
    bytes data;
}

struct ExecutionPlan {
    bytes32 callsHash;
}

struct Quote {
    uint256 expectedOut;
    uint256 fee;
    uint256 validUntil;
}

struct StakeSnapshot {
    uint256 amount;
    uint256 blockNumber;
}

struct HIEFSolution {
    bytes32 solutionVersion; // keccak256("0.1")
    bytes32 solutionId;
    bytes32 intentId;
    bytes32 intentHash;
    address solverId;
    bytes32 executionPlanHash;
    Quote quote;
    StakeSnapshot stakeSnapshot;
    bytes32 simulationHash; // 0x0 if absent
    bytes32 extensionsHash; // 0x0 if absent
}
```

### 8.4 callsHash 计算规则

```
callHash[i] = keccak256( encode(Call(to,value,data)) )
callsHash = keccak256( callHash[0] || callHash[1] || ... )
```

顺序 MUST 保持。

## 9. 签名规范

```json
"signature": {
    "type": "EIP712_EOA",
    "signer": "0xSolverAddress",
    "sig": "0x..."
}
```

- 签名 MUST 覆盖 `solutionHash`
- `signer` MUST == `solverId`
- Policy MUST 校验签名有效

## 10. 运行时校验（Policy MUST 执行）

Policy 在 `validateSolution` 时 MUST：

1.  `solution.intentHash` == recomputed `intentHash`
2.  `solution.intentId` == `intent.intentId`
3.  `deadline` 未过期
4.  `quote.validUntil` 未过期
5.  `expectedOut` ≥ `minAmount`
6.  `executionPlan` 不违反 Rulebook
7.  simulation 执行成功且资产 diff 符合 `expectedOut`

## 11. 示例 Solution

```json
{
    "solutionVersion": "0.1",
    "solutionId": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "intentId": "0x7f2b8a8d5d6d6f2b1b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7081920a0b0c0d",
    "intentHash": "0xintenthashplaceholder",
    "solverId": "0x2222222222222222222222222222222222222222",
    "executionPlan": {
        "calls": [
            {
                "to": "0xUniswapRouter",
                "value": "0",
                "data": "0xabcdef",
                "operation": "CALL"
            }
        ]
    },
    "quote": {
        "expectedOut": "250000000000000000",
        "fee": "1000000",
        "validUntil": 1777777700
    },
    "stakeSnapshot": {
        "amount": "1000000000000000000000",
        "blockNumber": 12345678
    },
    "simulationRef": {
        "type": "tenderly",
        "value": "sim-abc-123"
    },
    "signature": {
        "type": "EIP712_EOA",
        "signer": "0x2222222222222222222222222222222222222222",
        "sig": "0xSIGNATURE_PLACEHOLDER"
    }
}
```

## 12. 负例（未绑定 intentHash）

```json
{
    "solutionVersion": "0.1",
    "solutionId": "0xcccc...",
    "intentId": "0xintent",
    "solverId": "0x2222...",
    "executionPlan": { "calls": [] },
    "quote": { "expectedOut": "1", "fee": "0", "validUntil": 1777777 },
    "stakeSnapshot": { "amount": "1" },
    "signature": { "type": "EIP712_EOA", "signer": "0x2222...", "sig": "0x..." }
}
```

Policy MUST FAIL：缺少 `intentHash` 或 `intentHash` 不匹配。

## 13. v0.2 预留扩展

未来可增加：

- 部分填充（partial fill）语义
- 批量 Intent 组合执行
- MEV 分享字段
- 多资产输出数组
- 指定 Solver（`filler` allowlist）
