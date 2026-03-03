# HIEF Protocol — 工程文档包 v0.1

**HIEF (Hybrid Intent Execution Framework)** 是一个 AI DeFi Intent 基础设施协议，旨在成为所有 AI Agent 与 DeFi 执行层之间的标准化、安全的执行底座。

> **HIEF 不依赖于某个 AI 模型，它是所有 AI 模型的执行底座。**

---

## 文档结构

```
hief-protocol/
├── README.md                  # 本文件，项目入口
├── spec/                      # 协议规范（规范性文档）
│   ├── HIEF-INT-01.md         # Intent 对象与签名规范
│   ├── HIEF-SOL-01.md         # Solution 对象与绑定规范
│   ├── HIEF-POL-01.md         # PolicyResult 与验证输出规范
│   └── HIEF-REP-01.md         # Reputation 快照与更新语义规范
├── schemas/                   # JSON Schema 定义（可直接用于代码生成）
│   ├── intent.schema.json
│   ├── solution.schema.json
│   ├── policy-result.schema.json
│   └── reputation.schema.json
├── examples/                  # 正例与负例（用于测试）
│   ├── end-to-end/
│   │   ├── intent.example.json
│   │   ├── solution.example.json
│   │   └── policy-result.example.json
│   └── negative/
│       ├── intent.fail.deadline.json
│       └── solution.fail.unbound.json
├── api/                       # OpenAPI 规范（可直接生成 server stub）
│   └── hief-mvp.openapi.yaml
└── docs/                      # 架构与设计文档
    ├── architecture/
    │   └── state-machine.md   # Intent/Solution/Proposal 状态机
    ├── policy/
    │   ├── rulebook.md        # Policy 规则手册（14条规则）
    │   └── policy-engine-architecture.md
    ├── api/
    │   └── intent-bus-api.md
    ├── solver/
    │   └── solver-plugin-spec.md
    ├── adapter/
    │   └── safe-mapping.md
    └── dev/
        ├── mvp-directory-structure.md  # MVP 参考实现目录结构
        └── key-pseudocode.md           # 关键算法伪代码
```

---

## 核心流程

```
用户/AI Agent
    │
    ▼
POST /intents  ──→  Intent Bus  ──→  Solver 广播
                        │
                        ▼
                   Solver 报价  ──→  POST /solutions
                        │
                        ▼
                   用户选择  ──→  POST /intents/{id}/select
                        │
                        ▼
                   Policy 验证  ──→  validateSolution
                        │
                   ┌────┴────┐
                 PASS       FAIL
                   │
                   ▼
              Safe Adapter  ──→  Safe 提案  ──→  用户签名  ──→  上链执行
```

---

## 快速开始

### 1. 验证 JSON Schema

```bash
# 安装 ajv-cli
npm install -g ajv-cli

# 验证正例
ajv validate -s schemas/intent.schema.json -d examples/end-to-end/intent.example.json

# 验证负例（应该通过 schema 验证，但 Policy 应拒绝）
ajv validate -s schemas/intent.schema.json -d examples/negative/intent.fail.deadline.json
```

### 2. 生成 API Server Stub

```bash
# 使用 OpenAPI Generator
npx @openapitools/openapi-generator-cli generate \
  -i api/hief-mvp.openapi.yaml \
  -g typescript-express-server \
  -o packages/bus/src/generated
```

---

## 战略定位

HIEF 的核心护城河不在于某一项具体技术，而在于：

1.  **Intent 数据层**：拥有 Intent 流量，就拥有 DeFi 行为数据的护城河。
2.  **Policy 安全标准**：成为 AI+DeFi 执行安全的行业默认标准。
3.  **Solver 生态网络**：双边市场飞轮，用户越多 → Solver 越多 → 执行越优。
4.  **组合性护城河**：当 Skill、Policy、Solver 都在 HIEF 网络运行，迁移成本极高。

> **代码可以被 Fork，网络不可以被 Fork。**

---

## 版本历史

- `v0.1` (2026-03)：MVP 协议草案，支持单链 Swap Intent，集成 CoW/UniswapX。

---

## 代码实现（packages/）

| 包 | 说明 | 端口 |
|---|---|---|
| `@hief/common` | 共享类型、EIP-712 Hash 工具、常量 | — |
| `@hief/bus` | Intent Bus HTTP 服务（SQLite 状态机） | 3001 |
| `@hief/policy` | Policy Engine（12条规则 + Tenderly Fork 模拟） | 3002 |
| `@hief/solver` | CoW Protocol 适配器 + Safe 交易构建器 | 3003 |

### 安装与运行

```bash
# 安装所有依赖
pnpm install

# 构建 common 包（其他包依赖它）
cd packages/common && pnpm build

# 运行全部测试
pnpm test
```

### 测试结果

```
@hief/common    6/6  tests ✅
@hief/policy    9/9  tests ✅
@hief/solver    6/6  tests ✅
e2e             15/15 tests ✅
─────────────────────────────
Total           36/36 tests ✅
```

### 端到端流程（已验证）

```
Intent 创建 → intentHash 计算
    ↓
Solver 构建 Solution（CoW Protocol 报价）
    ↓
Policy Engine 验证（12条规则）
    ↓
Safe Adapter 构建 MultiSend 交易（planHash 绑定）
    ↓
用户签名 → 上链执行
```

### 环境变量

```bash
# Policy Engine（可选，启用 Fork 模拟）
TENDERLY_API_KEY=your_key
TENDERLY_ACCOUNT=your_account
TENDERLY_PROJECT=your_project

# Solver
BUS_URL=http://localhost:3001
SOLVER_ID=0x...  # Solver 钱包地址
```
