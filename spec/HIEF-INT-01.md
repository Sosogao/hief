# HIEF-INT-01：HIEF Intent 对象与签名规范 (v0.1)

- **状态**：Draft
- **版本**：0.1
- **范围**：单链 Intent（跨链扩展见 v0.2）
- **目标**：定义标准化 Intent 对象、规范性哈希与签名方案，使 Intent 可被 Solver 广播、可被 Policy 验证、可被 Adapter 映射为 Safe 可执行提案。

## 1. 术语

- **Intent**：用户对“期望结果”的声明（what），不包含具体执行路径（how）。
- **Solver**：接收 Intent 并提交执行方案（Solution）的执行者。
- **Policy**：对 Intent/Solution 做确定性校验与模拟验证的安全引擎。
- **Smart Account**：执行账户（例如 Safe、ERC-4337 账户）。
- **intentHash**：对 Intent 的规范性哈希，用于签名与防篡改绑定。

## 2. 设计原则

1.  **钱包无关（wallet-agnostic）**：Intent 不是 Safe 内部结构，不依赖某一钱包实现。
2.  **可审计绑定**：Intent 的“可执行语义字段”必须被 intentHash 覆盖并签名。
3.  **可扩展**：允许通过 extensions 扩展字段，但不影响 v0.1 的核心安全语义。
4.  **最小化链上依赖**：v0.1 不强制 Intent 上链，仅强制可验证的 hash 与签名。

## 3. Intent 对象（JSON）

### 3.1 顶层字段

Intent 对象 MUST 是一个 JSON 对象，包含以下字段：

- `intentVersion` (MUST)：固定为 `"0.1"`
- `intentId` (MUST)：0x 开头的 32 字节 hex（bytes32）
- `smartAccount` (MUST)：EVM 地址（用户资产控制账户，如 Safe）
- `chainId` (MUST)：number（EIP-155 chainId）
- `deadline` (MUST)：unix timestamp（秒）
- `input` (MUST)：输入资产对象
- `outputs` (MUST)：输出约束数组（v0.1 至少 1 个）
- `constraints` (MUST)：约束对象（可为空对象 `{}`，但字段名必须存在以便扩展）
- `priorityFee` (MUST)：Gas Market 优先费对象（允许 0）
- `policyRef` (MUST)：Policy 版本/策略集引用
- `reputationSnapshotRef` (SHOULD)：信誉快照引用（建议提供）
- `meta` (MAY)：UI/说明字段（不进入 hash）
- `extensions` (MAY)：扩展字段（进入 hash 的方式见 §4.4）
- `signature` (MUST)：签名对象（见 §5）

### 3.2 InputAsset

`input` MUST 为：

- `token` (MUST)：EVM 地址（ERC-20 地址，或 0xEeeee… 表示原生币，v0.1 建议用 WETH）
- `amount` (MUST)：字符串表示的十进制整数（避免 JS 精度问题）

### 3.3 OutputConstraint

`outputs` MUST 为数组，每个元素包含：

- `token` (MUST)：EVM 地址（ERC-20）
- `minAmount` (MUST)：字符串十进制整数（最小可接受输出）
- `recipient` (MAY)：默认等于 `smartAccount`；若提供，Policy SHOULD 校验是否在允许集合

v0.1：`outputs` MUST 与 `input` 在同一 `chainId` 上结算。

### 3.4 Constraints

`constraints` 为对象，v0.1 规范字段：

- `slippageBps` (MAY)：number（0~10_000）
- `maxSpend` (MAY)：字符串十进制整数（若要限制额外支出）
- `nonceSalt` (MAY)：0x32bytes（用于去重或并发 Intent）

### 3.5 PriorityFee（Intent Gas Market）

`priorityFee` MUST 为对象：

- `token` (MUST)：字符串，v0.1 固定 `"HIEF"`
- `amount` (MUST)：字符串十进制整数（允许 `"0"`）

注意：`priorityFee` 是“网络优先级资源”，不等价于链上 gas。

### 3.6 PolicyRef

`policyRef` MUST 为对象：

- `policyVersion` (MUST)：字符串（例如 `"pol-0.1.3"`）
- `policyHash` (MAY)：0x32bytes（策略集哈希，推荐提供）

### 3.7 ReputationSnapshotRef（建议）

`reputationSnapshotRef` SHOULD 为对象：

- `type` (MUST)：例如 `"block"` / `"hash"` / `"timestamp"`
- `value` (MUST)：字符串（例如 `"12345678"` 或 0x...）

用于：

- Solver/Policy 可复现“当时的信誉输入”
- 防止“信誉被回滚导致执行语义变化”的争议

### 3.8 Meta（不进入 hash）

`meta` MAY 包含：

- `title`
- `userIntentText`
- `tags`
- `uiHints`

`meta` MUST NOT 进入 `intentHash`。

### 3.9 Extensions（扩展字段）

`extensions` MAY 用于未来扩展（跨链、许可 Solver、隐私标记等）。

v0.1 对 `extensions` 的要求：

- `extensions` MUST 是 JSON 对象
- `extensions` 的“进入 hash”方式必须确定（见 §4.4）
- Policy MAY 在 v0.1 默认拒绝包含未知扩展字段的 Intent（实现策略由产品决定）

## 4. intentHash 计算规范

### 4.1 强制要求

- Intent MUST 计算出 `intentHash`。
- `signature` MUST 覆盖 `intentHash`（见 §5）。
- `meta` MUST NOT 影响 `intentHash`。
- `intentHash` MUST 与 `chainId` 绑定。

### 4.2 推荐方案：EIP-712 Typed Data

v0.1 强烈推荐使用 EIP-712 Typed Data 生成 `intentHash`。

#### 4.2.1 EIP-712 Domain

- `name`: `"HIEF"`
- `version`: `"0.1"`
- `chainId`: `intent.chainId`
- `verifyingContract`: `0x0000000000000000000000000000000000000000`（v0.1 先用零地址；若未来引入链上 Registry，可替换为 registry 合约地址）

v0.1 允许 `verifyingContract` 为 0 地址，以保持“链下标准层”属性。

#### 4.2.2 Types（规范性）

以下 Solidity-like 类型定义为规范性内容（实现 MUST 等价）：

```solidity
// HIEF-INT-01 v0.1 (Normative EIP-712 Types)
struct InputAsset {
    address token;
    uint256 amount;
}

struct OutputConstraint {
    address token;
    uint256 minAmount;
    address recipient; // if not provided in JSON, use smartAccount
}

struct Constraints {
    uint32 slippageBps; // 0..10000, default 0
    uint256 maxSpend; // default 0
    bytes32 nonceSalt; // default 0x0
}

struct PriorityFee {
    bytes32 token; // keccak256("HIEF") as bytes32 marker
    uint256 amount; // can be 0
}

struct PolicyRef {
    bytes32 policyVersion; // keccak256(policyVersionString)
    bytes32 policyHash; // 0x0 if absent
}

struct ReputationSnapshotRef {
    bytes32 refType; // keccak256(typeString)
    bytes32 refValue; // keccak256(valueString) OR direct bytes32 if already hash
}

struct HIEFIntent {
    bytes32 intentVersion; // keccak256("0.1")
    bytes32 intentId;
    address smartAccount;
    uint256 chainId;
    uint256 deadline;
    InputAsset input;
    bytes32 outputsHash; // hash of OutputConstraint[]
    Constraints constraints;
    PriorityFee priorityFee;
    PolicyRef policyRef;
    ReputationSnapshotRef reputationSnapshotRef;
    bytes32 extensionsHash; // 0x0 if absent
}
```

### 4.3 数组与哈希（outputsHash）

EIP-712 对动态数组实现差异较大。为保证跨语言一致性，v0.1 规定：

- `outputsHash` MUST 按以下方式计算：
    1.  对每个 `OutputConstraint` 计算 `outputItemHash`
    2.  将所有 `outputItemHash` 按顺序连接后 `keccak256`，得到 `outputsHash`

伪代码：

```
outputItemHash[i] = keccak256( encode(OutputConstraint(token, minAmount, recipientOrSmartAccount)) )
outputsHash = keccak256( outputItemHash[0] || outputItemHash[1] || ... )
```

要求：

- 输出数组顺序 MUST 保持（顺序改变会导致 hash 改变）
- 若 JSON 未提供 `recipient`，则 MUST 使用 `smartAccount`

### 4.4 extensionsHash（扩展字段进入 hash）

为保证扩展字段可验证且不破坏规范性哈希，v0.1 定义：

- 若不存在 `extensions`，则 `extensionsHash` = `0x0`
- 若存在 `extensions`，实现 MUST：
    - 使用 JSON Canonicalization Scheme (JCS) 将 `extensions` 规范化为字符串（字段排序、无多余空格）
    - 计算 `extensionsHash` = `keccak256(utf8(extensionsJcsString))`

这样任何语言都可确定性复现 `extensionsHash`，且不会把整个 `extensions` 细节强绑在 EIP-712 类型里。

## 5. 签名规范（signature）

### 5.1 签名类型

`signature.type` MUST ∈：

- `"EIP712_EOA"`：EOA 对 `intentHash` 的 EIP-712 签名
- `"SAFE"`：Safe 账户签名（建议用于多签）
- `"ERC1271"`：支持 ERC-1271 的合约签名

v0.1 推荐：用 Safe 本身作为 `smartAccount`，`signature` 使用 `SAFE/1271`。

### 5.2 signature 对象

`signature` MUST 包含：

- `type` (MUST)
- `signer` (MUST)：签名者地址（EOA 或合约）
- `sig` (MUST)：0x hex

签名语义：

- `sig` MUST 针对 `intentHash`（或 EIP-712 digest）有效
- `signer` MUST 与控制 `smartAccount` 的权限模型一致（例如 Safe owners 达到阈值）

## 6. 运行时校验（Policy SHOULD 做的校验）

Policy 引擎在 v0.1 SHOULD 至少校验：

1.  `deadline` MUST 在当前时间之后（否则 FAIL）
2.  `input.amount` > 0，`outputs[].minAmount` >= 0
3.  `constraints.slippageBps` 在 [0, 10000]
4.  `priorityFee.token` == `"HIEF"`
5.  `outputs` 与 `input` token 地址合法（非 0 地址，或明确允许的 native marker）
6.  `signature` 有效且与 `smartAccount` 权限模型一致（Safe 阈值/1271）
7.  若包含 `extensions`，在 MVP 阶段建议默认 WARN 或 FAIL（策略可配置）

## 7. 示例

### 7.1 示例 Intent（单链 swap+deposit 类意图）

注意：示例签名是占位符，实际实现需用 EIP-712 / Safe 签名生成。

```json
{
    "intentVersion": "0.1",
    "intentId": "0x7f2b8a8d5d6d6f2b1b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7081920a0b0c0d",
    "smartAccount": "0x1111111111111111111111111111111111111111",
    "chainId": 8453,
    "deadline": 1777777777,
    "input": {
        "token": "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "amount": "1000000000"
    },
    "outputs": [
        {
            "token": "0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2",
            "minAmount": "250000000000000000",
            "recipient": "0x1111111111111111111111111111111111111111"
        }
    ],
    "constraints": {
        "slippageBps": 50,
        "maxSpend": "0",
        "nonceSalt": "0x0000000000000000000000000000000000000000000000000000000000000000"
    },
    "priorityFee": {
        "token": "HIEF",
        "amount": "0"
    },
    "policyRef": {
        "policyVersion": "pol-0.1.3",
        "policyHash": "0x9a8b7c6d5e4f00112233445566778899aabbccddeeff00112233445566778899"
    },
    "reputationSnapshotRef": {
        "type": "block",
        "value": "12345678"
    },
    "meta": {
        "title": "USDC -> WETH with <=0.5% slippage",
        "userIntentText": "把 1000 USDC 换成尽可能多的 WETH，滑点不超过 0.5%"
    },
    "extensions": {
        "note": "v0.1 single-chain"
    },
    "signature": {
        "type": "SAFE",
        "signer": "0x1111111111111111111111111111111111111111",
        "sig": "0x<SAFE_SIGNATURE_PLACEHOLDER>"
    }
}
```

### 7.2 负例：过期 deadline（Policy 应 FAIL）

```json
{
    "intentVersion": "0.1",
    "intentId": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "smartAccount": "0x1111111111111111111111111111111111111111",
    "chainId": 8453,
    "deadline": 1600000000,
    "input": { "token": "0xA0b8...eb48", "amount": "1000000" },
    "outputs": [{ "token": "0xC02a...6Cc2", "minAmount": "1" }],
    "constraints": {},
    "priorityFee": { "token": "HIEF", "amount": "0" },
    "policyRef": { "policyVersion": "pol-0.1.3" },
    "signature": { "type": "EIP712_EOA", "signer": "0x2222...", "sig": "0x<sig>" }
}
```

## 8. 兼容性与演进（v0.2 展望）

v0.2 可能引入：

- 跨链 `outputs`（带 `chainId`）与桥接约束
- 许可 Solver（指定 `filler`/`solver` allowlist）
- 更强的 onchain registry（`verifyingContract` 不再为 0 地址）
- Intent Cancel / Replace 语义（基于 `nonceSalt` 或序列号）

v0.1 实现 SHOULD 以“可向后兼容”为目标：

- 忽略未知 `meta` 字段
- 对 `extensions` 使用 `extensionsHash` 机制进行版本化兼容
