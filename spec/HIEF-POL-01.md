# HIEF-POL-01：PolicyResult 与验证输出规范 (v0.1)

- **状态**：Draft
- **版本**：0.1
- **依赖**：
    - HIEF-INT-01 v0.1
    - HIEF-SOL-01 v0.1
- **目标**：定义 Policy 引擎对 Intent 与 Solution 的验证输出结构，使结果：
    - 可机器判定
    - 可人类解释
    - 可回归测试
    - 可审计复现
    - 可用于争议仲裁与 Slashing 证据

## 1. 设计目标

PolicyResult 必须满足五个原则：

1.  **决策确定性（Deterministic）**
    同样输入必须得到同样输出。
2.  **可解释性（Explainable）**
    必须告诉用户为什么 PASS/WARN/FAIL。
3.  **可复现性（Reproducible）**
    必须可以在未来重跑模拟验证。
4.  **可证据化（Evidence-based）**
    必须提供可引用的证据结构。
5.  **可版本化（Versioned）**
    不同 Policy 版本必须可区分。

## 2. PolicyResult 顶层结构

PolicyResult MUST 是一个 JSON 对象：

- `policyResultVersion` (MUST)：固定 `"0.1"`
- `policyRef` (MUST)：来自 `Intent.policyRef`
- `intentHash` (MUST)
- `solutionId` 或 `solutionHash` (MUST)
- `status` (MUST)
- `findings` (MUST)
- `riskTags` (MUST)
- `summary` (MUST)
- `evidenceRefs` (SHOULD)
- `executionDiff` (SHOULD)
- `timestamp` (MUST)
- `signature` (MAY)

## 3. Status 语义

`status` MUST ∈：

- `"PASS"` → 可进入执行流程
- `"WARN"` → 允许执行，但必须提示用户
- `"FAIL"` → 禁止执行

**规范性要求**

- 若存在任何 `severity` = `CRITICAL` 的 `finding` → `status` MUST = `FAIL`
- 若存在 `severity` = `HIGH` → `status` MUST ≥ `WARN`
- 只有当所有 `findings` 严重性 ≤ `INFO` → 才可 `PASS`

## 4. Findings 结构

`findings` MUST 为数组。

每个 `finding` MUST 包含：

- `ruleId` (MUST)
- `severity` (MUST)
- `message` (MUST)
- `evidence` (SHOULD)
- `relatedCallIndex` (MAY)

### 4.1 Severity 枚举

- `"INFO"`
- `"LOW"`
- `"MEDIUM"`
- `"HIGH"`
- `"CRITICAL"`

### 4.2 示例 Finding

```json
{
    "ruleId": "R5_APPROVE_LIMIT",
    "severity": "HIGH",
    "message": "Approval exceeds configured limit",
    "evidence": {
        "spender": "0xRouter",
        "approvedAmount": "1000000000000",
        "allowedLimit": "100000000"
    },
    "relatedCallIndex": 0
}
```

## 5. RiskTags

`riskTags` MUST 为字符串数组。

示例：

- `"TOKEN_TRANSFER"`
- `"APPROVAL_CHANGE"`
- `"SAFE_CONFIG_MODIFICATION"`
- `"UNKNOWN_CONTRACT"`
- `"HIGH_SLIPPAGE"`
- `"REPUTATION_LOW"`

RiskTags 主要用于：

- UI 风险标识
- 信誉分更新
- 统计分析

## 6. Summary（用户可读摘要）

`summary` MUST 为 1~5 条简洁文本。

示例：

```json
[
    "Swap will exchange 1000 USDC for >= 0.25 WETH.",
    "Slippage within configured limit (0.5%).",
    "No unsafe contract interaction detected."
]
```

`Summary` MUST 不包含技术术语或十六进制数据。

## 7. EvidenceRefs（可选但推荐）

```json
{
    "type": "simulation",
    "value": "sim-abc-123"
}
```

或：

```json
{
    "type": "ipfs",
    "value": "Qm..."
}
```

用途：

- 指向 fork 模拟记录
- 指向 diff 日志
- 指向完整 trace

Policy SHOULD 至少输出一种可复现引用。

## 8. ExecutionDiff（关键安全结构）

这是 HIEF 的核心安全证据结构。

Policy 在 Fork 模拟后 SHOULD 输出：

```json
{
    "tokenChanges": [
        {
            "account": "0x1111...",
            "token": "0xUSDC",
            "delta": "-1000000000"
        },
        {
            "account": "0x1111...",
            "token": "0xWETH",
            "delta": "250000000000000000"
        }
    ],
    "allowanceChanges": [
        {
            "owner": "0x1111...",
            "spender": "0xRouter",
            "newAllowance": "100000000"
        }
    ],
    "safeConfigChanged": false
}
```

### 8.1 规范要求

- Policy MUST 比较：
    - `Intent.input.amount`
    - `Intent.outputs[].minAmount`
    - 实际 `tokenChanges`
- 若 Safe owner 或 threshold 改变 → MUST `FAIL`
- 若资产流向未知地址且非 `recipient` → SHOULD `FAIL`

## 9. Signature（可选）

PolicyResult MAY 被签名：

```json
{
    "type": "POLICY_SERVER",
    "signer": "0xPolicyService",
    "sig": "0x..."
}
```

用于：

- 可验证执行裁决
- Slashing 争议仲裁

## 10. validateIntent vs validateSolution

Policy MUST 分两阶段：

### 10.1 validateIntent(Intent)

检查：

- `deadline`
- `input`/`output` 格式
- `priorityFee` 合法性
- `signature` 合法性
- `reputation` 规则

返回初步 PolicyResult（可为 `PASS`）

### 10.2 validateSolution(Intent, Solution)

检查：

1.  `intentHash` 绑定
2.  `solutionHash` 签名
3.  `executionPlan` 静态规则
4.  fork 模拟
5.  diff 分析
6.  `quote` 合理性
7.  `reputation` 影响

最终输出 PolicyResult。

## 11. 负例（FAIL 示例）

```json
{
    "policyResultVersion": "0.1",
    "policyRef": {
        "policyVersion": "pol-0.1.3"
    },
    "intentHash": "0xintenthash",
    "solutionId": "0xsolutionid",
    "status": "FAIL",
    "findings": [
        {
            "ruleId": "R1_NO_DELEGATECALL",
            "severity": "CRITICAL",
            "message": "DELEGATECALL detected",
            "relatedCallIndex": 0
        }
    ],
    "riskTags": ["SAFE_CONFIG_MODIFICATION"],
    "summary": [
        "Solution attempts to use DELEGATECALL, which is prohibited."
    ],
    "timestamp": 1700000000
}
```

## 12. v0.2 可扩展方向

未来可加入：

- 自动风险评分（`riskScore` 0~100）
- 机器可读裁决码（`errorCode`）
- MEV 分析结果
- 多模拟源共识（双模拟一致性）
