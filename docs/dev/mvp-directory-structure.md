# HIEF MVP 参考实现目录结构

这是一个建议的 Monorepo 目录结构（以 Node.js/TypeScript 为例），旨在实现模块化、可测试和清晰的边界。

```
hief/
├── spec/                      # 协议规范 (HIEF-INT-01, etc.)
│   ├── HIEF-INT-01.md
│   └── ...
├── schemas/                   # JSON Schema 定义
│   ├── intent.schema.json
│   └── ...
├── examples/                  # 正例与负例
│   ├── end-to-end/
│   └── negative/
├── docs/                      # 架构与设计文档
│   ├── architecture/
│   ├── policy/
│   └── ...
├── api/                       # OpenAPI 规范
│   └── hief-mvp.openapi.yaml
└── packages/                  # Monorepo 中的各个模块
    ├── common/                # 通用库 (types, hash, crypto, abi)
    │   ├── src/
    │   │   ├── types/         # 从 JSON Schema 生成的 TS 类型
    │   │   ├── hash/          # intentHash, solutionHash, planHash 实现
    │   │   ├── crypto/        # EIP-712, signature verification
    │   │   └── config/        # 全局常量与配置
    │   └── package.json
    ├── bus/                   # Intent Bus (核心后端服务)
    │   ├── src/
    │   │   ├── api/           # Express/Fastify 路由实现
    │   │   ├── db/            # 数据库模型 (Prisma/TypeORM)
    │   │   ├── state/         # 状态机逻辑
    │   │   ├── selection/     # Solution 排序与选择
    │   │   ├── broadcast/     # Solver 广播逻辑
    │   │   └── orchestration/ # 核心流程编排
    │   └── Dockerfile
    ├── policy/                # Policy Engine (独立安全服务)
    │   ├── src/
    │   │   ├── api/           # 引擎的 API 入口
    │   │   ├── rules/         # Rulebook 的代码实现
    │   │   ├── simulator/     # Anvil/Tenderly Fork 管理
    │   │   ├── diff/          # 状态差异比较
    │   │   └── builder/       # PolicyResult 构建器
    │   └── Dockerfile
    ├── adapter-safe/          # Safe 映射适配器
    │   ├── src/
    │   │   ├── multisend.ts   # MultiSend 打包逻辑
    │   │   └── tx-service.ts  # 与 Safe Tx Service 对接
    │   └── package.json
    └── solver-adapters/       # 第三方 Solver 适配器
        ├── cow/
        ├── uniswapx/
        └── mock-solver/       # 用于测试的模拟 Solver
```


## 模块职责

- **`common`**: 提供无副作用的纯函数和类型定义，被所有其他模块依赖。
- **`bus`**: 核心业务逻辑，处理 Intent 的生命周期，是系统的“大脑”。
- **`policy`**: 计算密集型安全服务，可独立部署和扩展。
- **`adapter-safe`**: 将验证后的结果转换为特定平台的执行格式。
- **`solver-adapters`**: 扩展 HIEF 生态的插件。
