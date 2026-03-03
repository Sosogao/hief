# HIEF 到 Safe 的映射规范 (SAFE_V1, v0.1)

本规范定义了如何将一个经过 Policy 验证通过的 `Solution` 安全地转换为 Gnosis Safe 可执行的交易提案。这是连接“意图”与“最终执行”的关键桥梁。

## 1. 核心原则：禁止篡改

**Policy 验证的对象必须等于 Safe 执行的对象。**

Adapter 在映射过程中，绝对不能以任何形式修改 `Solution.executionPlan` 的核心语义（`to`, `value`, `data`）。

## 2. 输入与输出

- **输入**:
    - `Intent` (HIEF-INT-01)
    - `Solution` (HIEF-SOL-01)
    - `PolicyResult` (状态为 `PASS` 或 `WARN`)
- **输出**:
    - `SafeTx` 对象（可被 Safe Tx Service 接受）
    - `safeTxHash` (用于追踪)
    - `proposalId` (HIEF 内部 ID)

## 3. 交易打包策略

### 3.1 单一调用

如果 `executionPlan.calls` 数组长度为 1：

- `SafeTx.to` = `call.to`
- `SafeTx.value` = `call.value`
- `SafeTx.data` = `call.data`
- `SafeTx.operation` = `0` (CALL)

### 3.2 多个调用 (MultiSend)

如果 `executionPlan.calls` 数组长度 > 1，**必须** 使用 Gnosis Safe 的 `MultiSend` 合约进行打包：

1.  为每个 `call` 创建一个 `MultiSend` 交易单元。
2.  将所有交易单元编码为 `MultiSend` 的 `transactions` 参数。
3.  构造最终的 `SafeTx`:
    - `SafeTx.to` = `MultiSend` 合约地址
    - `SafeTx.value` = `0`
    - `SafeTx.data` = 编码后的 `MultiSend` 调用数据
    - `SafeTx.operation` = `0` (CALL)

这种方式确保了多个操作的原子性，与 Policy 引擎模拟的原子执行环境保持一致。

## 4. 一致性哈希 (planHash)

为了提供额外的防篡改保障，Adapter 必须计算一个 `planHash`。

- **计算方法**:
    1.  计算 `callsHash` (见 HIEF-SOL-01 §8.4)。
    2.  `planHash = keccak256(abi.encodePacked(callsHash, intentHash, solutionId))`
- **存储与展示**:
    - `planHash` 必须与 `proposalId` 一同存储。
    - 在用户签名前，UI 应该清晰地展示 `intentHash` 和 `planHash`，允许用户进行核对。

## 5. 与 Safe Tx Service 的集成

当将提案提交到 Safe Tx Service 时，`description` 字段应该包含丰富的上下文信息，方便多签成员决策：

- **Intent ID**: `intentId`
- **Solution ID**: `solutionId`
- **Policy Status**: `PASS` / `WARN`
- **Policy Summary**: `policyResult.summary`
- **Evidence Link**: 指向 `policyResult.evidenceRefs` 的链接

## 6. 用户体验要求 (强制)

在请求用户对 Safe 交易进行签名之前，前端界面 **必须** 清晰、显著地展示以下信息：

1.  **人类可读的摘要**: `policyResult.summary` (e.g., "你要用 1000 USDC 换至少 0.25 WETH")
2.  **关键风险点**: `policyResult.findings` 中所有 `severity` >= `HIGH` 的 `message`。
3.  **最小输出**: `intent.outputs[].minAmount`
4.  **费用**: `solution.quote.fee`
5.  **执行账户**: `intent.smartAccount`
6.  **防篡改哈希**: `intentHash` 和 `planHash` (可复制)

## 7. 执行回调

Safe 交易执行后，系统必须监听交易回执，并记录：

- `txHash`
- `status` (success/fail)
- `gasUsed`
- `revertReason` (如果失败)

这些信息将用于触发 Intent、Solver 和用户信誉的更新。
