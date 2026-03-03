# HIEF Policy Rulebook (v0.1)

本规则手册定义了 HIEF Policy 引擎在 MVP 阶段必须（MUST）和应该（SHOULD）执行的验证规则。所有规则都必须有唯一的 `ruleId`。

## 1. 静态验证规则（不依赖 Fork 模拟）

### R1: Intent 结构与签名验证

- **ruleId**: `R1_INTENT_VALIDITY`
- **Severity**: `CRITICAL`
- **检查点**: `validateIntent`
- **描述**: 验证 Intent 结构是否符合 HIEF-INT-01 规范，`intentHash` 计算是否正确，`signature` 是否有效且与 `smartAccount` 权限模型匹配。
- **失败条件**: 结构不符、哈希不匹配、签名无效。

### R2: Solution 结构与签名验证

- **ruleId**: `R2_SOLUTION_VALIDITY`
- **Severity**: `CRITICAL`
- **检查点**: `validateSolution`
- **描述**: 验证 Solution 结构是否符合 HIEF-SOL-01 规范，`solutionHash` 计算是否正确，`signature` 是否有效且与 `solverId` 匹配。
- **失败条件**: 结构不符、哈希不匹配、签名无效。

### R3: 时间戳与绑定验证

- **ruleId**: `R3_BINDING_AND_EXPIRATION`
- **Severity**: `CRITICAL`
- **检查点**: `validateSolution`
- **描述**: 验证 `solution.intentHash` 是否与当前 `intentHash` 严格相等，`intent.deadline` 和 `solution.quote.validUntil` 是否未过期。
- **失败条件**: 哈希不匹配、任一时间戳已过期。

### R4: ExecutionPlan 静态扫描

- **ruleId**: `R4_EXECUTION_PLAN_STATIC_SCAN`
- **Severity**: `CRITICAL`
- **检查点**: `validateSolution`
- **描述**: 扫描 `executionPlan.calls` 数组，检查是否存在高风险操作。
- **失败条件**:
    - `operation` 为 `DELEGATECALL`。
    - `to` 地址在全局黑名单中。
    - `data` 包含已知的恶意函数选择器（如 `setOwner`, `addOwner`, `changeThreshold` 等）。

### R5: 经济承诺检查

- **ruleId**: `R5_ECONOMIC_COMMITMENT`
- **Severity**: `HIGH`
- **检查点**: `validateSolution`
- **描述**: 检查 Solver 的经济承诺是否合理。
- **失败条件**:
    - `quote.expectedOut` < `intent.outputs[].minAmount`。
    - `quote.fee` 超过系统配置的上限（例如 `intent.input.amount` 的 5%）。

## 2. 动态验证规则（依赖 Fork 模拟）

### R10: 资产变更一致性（Diff 引擎）

- **ruleId**: `R10_ASSET_DIFF_CONSISTENCY`
- **Severity**: `CRITICAL`
- **检查点**: `validateSolution`
- **描述**: 模拟执行 `executionPlan`，比较模拟前后的状态差异（`executionDiff`），验证资产变更是否符合预期。
- **失败条件**:
    - `smartAccount` 的 `input.token` 减少量 > `input.amount` + `quote.fee`。
    - `smartAccount` 的 `outputs[].token` 增加量 < `quote.expectedOut`。
    - 资产流向了非 `smartAccount` 或 `recipient` 的未知地址。

### R11: Safe 配置变更检查

- **ruleId**: `R11_SAFE_CONFIG_IMMUTABILITY`
- **Severity**: `CRITICAL`
- **检查点**: `validateSolution`
- **描述**: 模拟执行后，检查 Safe 的配置（owners, threshold）是否发生变更。
- **失败条件**: `executionDiff.safeConfigChanged` 为 `true`。

### R12: 无限授权检查

- **ruleId**: `R12_UNLIMITED_APPROVAL`
- **Severity**: `HIGH`
- **检查点**: `validateSolution`
- **描述**: 检查 `executionPlan` 中 `approve` 调用，是否授权了 `type(uint256).max`。
- **警告条件**: 存在无限授权调用。SHOULD 降级为有限授权或要求用户确认。

### R13: 交易可执行性检查

- **ruleId**: `R13_TRANSACTION_EXECUTABILITY`
- **Severity**: `CRITICAL`
- **检查点**: `validateSolution`
- **描述**: 检查模拟交易是否成功执行，没有 revert。
- **失败条件**: 模拟交易 revert。

### R14: Gas 消耗合理性

- **ruleId**: `R14_GAS_CONSUMPTION`
- **Severity**: `MEDIUM`
- **检查点**: `validateSolution`
- **描述**: 检查模拟执行的 Gas 消耗是否在合理范围内。
- **警告条件**: Gas 消耗远超同类交易的平均水平，可能存在 Gas 耗尽攻击风险。

## 3. 信誉验证规则

### R20: 用户信誉检查

- **ruleId**: `R20_USER_REPUTATION`
- **Severity**: `LOW` / `MEDIUM`
- **检查点**: `validateIntent`
- **描述**: 检查 `intent.smartAccount` 的信誉分。
- **警告条件**: `riskScore` > 阈值，或 `successRate` < 阈值。可用于触发更严格的 Policy 规则。

### R21: Solver 信誉检查

- **ruleId**: `R21_SOLVER_REPUTATION`
- **Severity**: `LOW` / `MEDIUM`
- **检查点**: `validateSolution`
- **描述**: 检查 `solution.solverId` 的信誉分。
- **警告条件**: Solver 的 `successRate` 或 `avgSlippage` 不佳。可用于在排序时降权。
