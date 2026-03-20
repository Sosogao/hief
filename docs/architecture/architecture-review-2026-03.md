# HIEF 架构审视报告 v1.0

> 撰写日期：2026-03-20
> 触发背景：参考 Tempo Network（docs.tempo.xyz）和 MPP（mpp.dev）两个 AI Agent 支付协议，评估 HIEF 现有架构的先进性与演进方向。

---

## 一、参考协议速览

### Tempo Network
- 专为机器支付设计的 L1 公链（Reth SDK + Simplex BFT，~500ms 确定性）
- 核心创新：2D 并发 nonce、无原生 gas 代币（用稳定币付手续费）、Access Key（带限额的委托签名密钥）、Session Channel（链下凭证 + 批量结算）
- SDK：TypeScript 用 **viem**，Python/Rust/Go 均有支持

### MPP（Machine Payments Protocol）
- Stripe + Tempo 联合起草的 HTTP 支付标准，复活 **HTTP 402 Payment Required**
- 三段握手：Challenge（402 返回）→ Credential（客户端付款证明）→ Receipt（服务端确认）
- 三种计费模式：Charge（单次）/ Session（escrow + 链下凭证）/ Streamed（按 token/unit 计费）
- 原生支持 **MCP（Model Context Protocol）** binding — AI tool 调用即自动付款
- TypeScript SDK `mppx.fetch()` 使用 **viem**，正在走 IETF 标准化

---

## 二、HIEF 现状评估

### 技术栈
| 项目 | 现状 |
|---|---|
| 链交互库 | ethers.js v6（全部 8 个包） |
| AA 方案 | Safe + ERC-4337（Safe4337Module） |
| Intent Schema | 自定义 HIEFIntent（v0.1） |
| AI 模型 | OpenAI API（gpt-4.1-mini，可切换） |
| 费用模型 | `priorityFee.amount = '0'`（占位，未实装） |
| 跨链支持 | 无（单链） |

### 不需要担心的部分 ✅
- **Intent-based 架构**：方向正确，与行业共识（ERC-7683、UniswapX、Across）完全一致
- **Policy Engine（规则 + Tenderly 模拟）**：合理的安全设计，无过时风险
- **Safe + ERC-4337**：AA 行业标准，长期有效
- **OpenAI API 解耦**：可随时换模型，无供应商锁定

### 需要关注的部分 ⚠️
1. **ethers.js → viem**：新 AA 项目（Pimlico、ZeroDev、Alchemy AA SDK）已普遍用 viem，类型更安全，tree-shaking 更好
2. **HIEFIntent schema 与 ERC-7683 对齐**：跨链扩展时需要兼容
3. **费用模型空缺**：商业化前必须设计，参考 MPP Session Channel 模式
4. **Session Key 缺失**：无法实现自动化执行，UX 摩擦大

---

## 三、P2：ERC-7683 跨链 Intent 标准兼容

### HIEFIntent 与 ERC-7683 字段对比

| HIEFIntent 字段 | ERC-7683 对应 | 状态 |
|---|---|---|
| `smartAccount` | `swapper` | ✅ 直接对应 |
| `intentId` | `nonce` | ✅ 语义相同 |
| `deadline` | `fillDeadline` | ✅ 直接对应 |
| `chainId` | `originChainId` | ✅ 有，单链 |
| `input: InputAsset` | `maxSpent[0]` | ✅ 结构一致 |
| `outputs: OutputConstraint[]` | `minReceived[]` | ✅ 结构一致 |
| `constraints.slippageBps` | — | HIEF 独有，可放 `orderData` |
| `priorityFee` | — | HIEF 独有 |
| `policyRef` | — | HIEF 独有 |
| `reputationSnapshotRef` | — | HIEF 独有 |
| — | `settlementContract` | ❌ HIEF 缺失 |
| — | `output.chainId`（目标链） | ❌ HIEF 缺失 |
| — | `fillInstructions` | ❌ HIEF 缺失 |

**核心 token/amount 模型 ~70% 重叠，差距集中在跨链字段和链上结算合约。**

### 推荐策略：Schema 超集（Strategy B）

在 `HIEFIntent` 上加可选跨链字段，向下兼容现有单链用法：

```typescript
interface HIEFIntent {
  // 现有字段不变 ...

  // ERC-7683 兼容扩展（跨链时使用）
  destChainId?: number;
  settlementContract?: Address;
  fillInstructions?: FillInstruction[];
}
```

- 单链 intent → 忽略新字段，行为不变
- 跨链 intent → 填写新字段，外部 ERC-7683 solver 可解析
- HIEF 特有字段（policy/reputation）通过 `orderData` 透传给标准接口

### 实现路径

```
v0.2（当前迭代）
  ├── HIEFIntent 加可选跨链字段（types/index.ts ~10 行）
  ├── intentHash.ts 加跨链哈希路径
  └── 适配器函数 toERC7683(intent) / fromERC7683(order)

v0.3
  └── Solver 路由层：destChainId 存在时走跨链路径

v0.4（需链上合约 + 审计）
  ├── 部署 HIEFSettlementContract（兼容 ERC-7683 IOriginSettler）
  └── 对接第一个跨链桥（Across / Stargate）
```

---

## 四、P5：Session Key / EIP-7702

### 当前 UX 问题

每笔交易都需要用户手动打开 MetaMask 签名，导致：
- 频繁小额操作（定投、再平衡）摩擦极大
- 自动化策略（止损、条件触发）完全无法实现
- AI 自主执行模式的根本性障碍

### Session Key 核心概念

用户一次性授权 HIEF agent 持有一个**受约束的签名密钥**：

```
用户授权（一次）：
  "允许 HIEF 用 session key 签名，约束：
   - 有效期：最长 7 天
   - 单笔上限：1000 USD
   - 总额上限：10000 USD（达到后自动失效）
   - 允许协议：Aave、Uniswap、f(x)
   - 允许操作：SWAP、DEPOSIT、WITHDRAW
   - 必须通过 Policy Engine 验证
   - 可随时撤销"

之后 HIEF 自动执行，不再弹 MetaMask
```

### 各账户模式接入方案

| 账户类型 | 技术方案 | 成熟度 |
|---|---|---|
| EOA | EIP-7702 + session key contract | ✅ Pectra 已上线（2025-05） |
| Safe Multisig | Rhinestone Safe Session Key Module | ✅ 已上线 |
| Safe+4337 | ZeroDev Kernel v3 Permission Plugin | ✅ 已上线 |

### Session Key 与 Policy Engine 的天然结合

Policy Engine 的规则集 = Session Key 的 constraints，可以直接复用：

```
授权时：用户确认"这个 session key 受哪些 Policy 规则约束"
执行时：Policy Engine 验证 session 约束 → 通过 → 无需用户签名
```

新增规则 **R13: SESSION_KEY_WITHIN_CONSTRAINTS** 验证：
1. Session key 未过期
2. 单笔 USD 值不超限
3. 协议在白名单
4. Intent type 在白名单
5. 累计消耗未超总上限

### HIEFSessionGrant 数据结构

```typescript
interface HIEFSessionGrant {
  sessionKeyAddress: Address;     // HIEF agent 持有的热密钥
  userAccount: Address;           // 用户 Safe 地址
  grantedAt: number;
  expiresAt: number;              // 建议最长 7 天

  constraints: {
    maxSpendPerTxUSD: number;       // 单笔上限
    maxSpendTotalUSD: number;       // 总上限
    allowedProtocols: string[];     // ['aave', 'fx', 'lido']
    allowedIntentTypes: string[];   // ['SWAP', 'DEPOSIT', 'WITHDRAW']
    allowedTokens?: Address[];      // 可选，限定 token 列表
    requirePolicyPass: true;        // 强制通过 Policy Engine
  };

  spentUSD: number;               // 运行时累计消耗（服务端维护）
  userSignature: HexString;       // 用户对 grant 的 EIP-712 签名
  revokedAt?: number;
}
```

### 执行流程对比

**现在：**
```
用户说 "swap 100 USDC" → AI 解析 → Policy ✅ → Solver 报价
  → 用户确认 → MetaMask 签名 ← 摩擦点
  → 执行
```

**加 Session Key 后：**
```
[一次性] 用户 → 授权页面 → MetaMask 签名 session grant

[之后每次]
用户说 "swap 100 USDC" → AI 解析 → Policy ✅（含 R13）
  → Solver 报价 → AI 摘要确认（无 MetaMask）
  → HIEF session key 自动签名 → 执行
```

高风险操作（超单笔限额、新协议）仍要求完整签名。

### 实现路径

```
Phase 1（v0.2，~2 周，纯后端，无合约）
  ├── HIEFSessionGrant 类型定义（packages/common）
  ├── session key 生成 + 加密存储（server-side）
  ├── Policy Engine R13 规则
  └── 授权 / 撤销 UI（explorer）

Phase 2（v0.3，~3 周，需集成外部 SDK）
  ├── EOA：EIP-7702 delegation tx
  ├── Safe+4337：ZeroDev Permission Plugin
  └── Safe Multisig：Rhinestone Safe Session Key Module

Phase 3（v0.4+，自动化策略）
  ├── 定时 intent（cron-based）
  └── 条件触发（价格 oracle → intent）
```

---

## 五、长期愿景架构图

```
用户（一次性 session grant）
    ↓
HIEF Agent（持有 session key + OpenAI 解析）
    ↓ 生成 HIEFIntent（ERC-7683 超集）
Policy Engine（R1-R13，含 session 约束验证）
    ↓
Solver Network（单链 DeFi Skills / 跨链路由）
    ↓ session key 自动签名（或 MetaMask）
链上执行
  ├── 单链：Safe / EOA 直接调用
  └── 跨链：HIEFSettlementContract（ERC-7683 IOriginSettler）
              → Across / Stargate 桥接
              → 目标链 FillInstruction 执行
```

---

## 六、实施路线图与任务清单

### v0.2（近期，2-3 周）

| 任务 | 优先级 | 模块 | 工作量 |
|---|---|---|---|
| ERC-7683 超集字段加入 HIEFIntent | P2 | common | 小（1天） |
| intentHash.ts 跨链哈希路径 | P2 | common | 小（1天） |
| toERC7683 / fromERC7683 适配器函数 | P2 | common | 小（1天） |
| HIEFSessionGrant 类型定义 | P5 | common | 小（半天） |
| Policy Engine R13 规则（session 约束） | P5 | policy | 中（2天） |
| session key 生成 + 加密存储 | P5 | solver-network | 中（2天） |
| 授权 / 撤销 UI | P5 | explorer | 中（3天） |

### v0.3（中期，3-4 周）

| 任务 | 优先级 | 模块 | 工作量 |
|---|---|---|---|
| Solver 路由层：destChainId 跨链分支 | P2 | solver-network | 中 |
| EOA EIP-7702 session key 接入 | P5 | solver-network | 中 |
| Safe+4337 ZeroDev Permission Plugin | P5 | solver-network | 中 |
| Safe Multisig Rhinestone Module | P5 | solver-network | 中 |
| 费用模型设计（Session Channel 模式） | P1 | common + bus | 中 |

### v0.4（长期，需链上合约）

| 任务 | 优先级 | 模块 | 工作量 |
|---|---|---|---|
| HIEFSettlementContract 部署（ERC-7683） | P2 | contracts | 大（需审计） |
| 跨链桥对接（Across / Stargate） | P2 | solver-network | 大 |
| 定时 intent（cron 自动化） | P5 | agent | 中 |
| 条件触发 intent（价格 oracle） | P5 | agent | 中 |
| viem 迁移（新模块优先） | P3 | 全局 | 渐进 |
| MCP tool 暴露（HIEF as MCP server） | P4 | agent | 中 |

---

## 七、其他参考标准

| 标准 | 关联性 | 建议 |
|---|---|---|
| ERC-7683 (CrossChainOrder) | P2 核心 | 按超集策略兼容 |
| ERC-7715 (Session Keys) | P5 参考 | 参考约束数据结构 |
| EIP-7702 (EOA delegation) | P5 EOA 路径 | v0.3 实装 |
| MPP / x402 (HTTP 402) | 费用模型参考 | 商业化时采用 Session Channel |
| ERC-4337 v0.7 (2D nonce) | 并发优化 | 改善并发 UserOp 提交 |
