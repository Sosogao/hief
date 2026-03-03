# HIEF Policy 引擎架构 (v0.1)

Policy 引擎是 HIEF 的安全内核，负责对所有 Intent 和 Solution 进行确定性的安全校验。本架构旨在实现高性能、可扩展、可审计的验证流程。

## 1. 核心组件

```mermaid
graph TD
    A[API Gateway] --> B{Orchestrator};
    B --> C[Static Validator];
    B --> D[Dynamic Validator (Simulator)];
    D --> E[Diff Engine];
    C --> F[Result Builder];
    E --> F;
    F --> G[Output (PolicyResult)];

    subgraph Static Validation
        C -- R1-R5 --> C;
    end

    subgraph Dynamic Validation
        D -- R10-R14 --> D;
        E -- Compares state before/after --> E;
    end
```

- **Orchestrator**: 流程编排器，接收请求，依次调用静态和动态验证器。
- **Static Validator**: 静态验证器，执行不依赖链上状态模拟的规则（R1-R5）。
- **Dynamic Validator (Simulator)**: 动态验证器，负责创建链上状态的 Fork，并模拟执行 `executionPlan`。
- **Diff Engine**: 状态差异比较引擎，对比模拟前后的关键状态（资产、授权、配置），生成 `executionDiff`。
- **Result Builder**: 结果生成器，汇总所有验证器的 `findings`，生成最终的 `PolicyResult`。

## 2. 验证流程

### 2.1 `validateIntent` 流程

1.  **Orchestrator** 接收 `validateIntent(Intent)` 请求。
2.  调用 **Static Validator** 执行 `R1_INTENT_VALIDITY` 和 `R20_USER_REPUTATION`。
3.  **Result Builder** 汇总结果，生成 `PolicyResult` 并返回。

这是一个轻量级的前置检查，用于快速过滤无效或高风险的 Intent。

### 2.2 `validateSolution` 流程

1.  **Orchestrator** 接收 `validateSolution(Intent, Solution)` 请求。
2.  **Static Validator** 执行 `R2_SOLUTION_VALIDITY`, `R3_BINDING_AND_EXPIRATION`, `R4_EXECUTION_PLAN_STATIC_SCAN`, `R5_ECONOMIC_COMMITMENT`, `R21_SOLVER_REPUTATION`。
3.  如果静态验证有 `CRITICAL` 发现，流程提前终止，**Result Builder** 生成 `FAIL` 结果。
4.  **Dynamic Validator** 启动：
    a.  基于 `intent.chainId` 和最近的区块创建 Anvil/Tenderly Fork。
    b.  获取 `smartAccount` 模拟前的状态（余额、授权等）。
    c.  模拟执行 `solution.executionPlan`。
    d.  获取模拟后的状态。
5.  **Diff Engine** 对比前后状态，生成 `executionDiff`。
6.  **Dynamic Validator** 基于 `executionDiff` 和模拟结果，执行 `R10_ASSET_DIFF_CONSISTENCY`, `R11_SAFE_CONFIG_IMMUTABILITY`, `R12_UNLIMITED_APPROVAL`, `R13_TRANSACTION_EXECUTABILITY`, `R14_GAS_CONSUMPTION`。
7.  **Result Builder** 汇总静态和动态验证的所有 `findings`，根据严重性计算最终 `status`，生成完整的 `PolicyResult`。

## 3. 技术选型（MVP 建议）

- **模拟器**: **Anvil (Foundry)**。性能高，易于集成，适合作为核心模拟引擎。
- **备用模拟器**: **Tenderly API**。作为 Anvil 无法处理某些复杂场景时的备用方案。
- **实现语言**: **Rust** 或 **Go**。高性能，适合构建计算密集型的安全服务。

## 4. 性能与扩展性

- **并行处理**: Policy 引擎应设计为可水平扩展的无状态服务，每个验证请求都在独立的沙箱（Docker 容器）中处理，避免状态污染。
- **缓存**: 可以对已知安全的合约、函数选择器进行缓存，减少重复的静态分析。
- **异步化**: `validateSolution` 是一个耗时操作（通常 1-3 秒），API 应设计为异步模式，客户端通过 webhook 或轮询获取结果。

## 5. 安全与审计

- **Rulebook 版本化**: `rulebook.md` 必须与代码实现严格对应，并纳入版本控制。
- **证据存储**: 所有 `evidenceRefs` 指向的模拟 trace 和 diff 日志都应被持久化存储（如 S3），用于审计和争议解决。
- **自测试**: Policy 引擎必须包含一个完整的测试套件，覆盖 `rulebook.md` 中的所有规则以及 `examples/` 中的所有正例和负例。
