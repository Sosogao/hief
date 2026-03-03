# HIEF Solver Plugin Spec (v0.1)

本规范定义了第三方 Solver 如何作为“插件”接入 HIEF 网络并参与 Intent 竞价。目标是实现一个开放、公平的 Solver 生态。

## 1. 核心流程

1.  **发现 (Discovery)**: Solver 从 Intent Bus 接收新的 Intent。
2.  **求解 (Solving)**: Solver 根据 Intent 约束，寻找最优的执行路径（如通过 1inch, Uniswap, CoW Protocol 等）。
3.  **报价 (Quoting)**: Solver 将执行路径和经济承诺打包成一个 `Solution` 对象。
4.  **提交 (Submitting)**: Solver 对 `Solution` 签名，并提交给 Intent Bus。

## 2. 交互模式

HIEF 支持两种模式，Solver 至少需要实现一种。

### 2.1 Pull 模式 (推荐)

- **流程**: Intent Bus 主动向已注册的 Solver 拉取报价。
- **Solver 责任**: 实现一个标准的 HTTP 端点 `POST /solver/quote`。
- **Request Body**: `{ intent, intentHash, reputation, policyRef }`
- **Response Body**: `Solution` 对象 (HIEF-SOL-01)
- **优点**: 简单，易于集成。Bus 可以控制请求频率和超时。

### 2.2 Push 模式

- **流程**: Solver 监听 Intent Bus 的广播（如 WebSocket），并主动推送 Solution。
- **Solver 责任**: 调用 Intent Bus 的 `POST /solutions` 端点。
- **优点**: 实时性高，适合高频或复杂的 Solver。

## 3. 适配现有 Solver

任何现有的链上或链下撮合系统都可以通过一个“适配器”接入 HIEF。

### 3.1 CoW Protocol 适配器

- **逻辑**: CoW Protocol 的 `Order` 本质上就是一种对 Swap Intent 的求解。
- **适配器工作**:
    1.  将 HIEF `Intent` 转换为 CoW `Order`。
    2.  监听 CoW Protocol 返回的 `Quote` 或执行结果。
    3.  将 CoW 的执行路径（调用 `CoW settlement` 合约）和 `Quote` 包装成 HIEF `Solution`。
    4.  提交给 Intent Bus。

### 3.2 UniswapX 适配器

- **逻辑**: UniswapX 的 `Signed Order` + `Filler` 模型与 HIEF 的 `Intent` + `Solver` 模型高度相似。
- **适配器工作**:
    1.  将 HIEF `Intent` 转换为 UniswapX `Order`。
    2.  将 UniswapX `Filler` 的执行路径（通常涉及 `Permit2` 和 `Reactor` 合约）包装到 `Solution.executionPlan` 中。
    3.  提交给 Intent Bus。

## 4. 信誉与激励 (v0.1)

在 MVP 阶段，HIEF 主要记录 Solver 的表现数据，暂不引入链上质押和 Slashing。

- **记录指标**:
    - `successRate`: 成功执行率
    - `avgSlippage`: 平均滑点（与报价相比）
    - `rejectedCount`: 被 Policy 拒绝的次数
- **作用**: 这些指标将用于 `v0.2` 的 Solver 排序和权重计算，表现好的 Solver 将在 Pull 模式中被优先轮询。

## 5. 结论

HIEF 的核心护城河不在于自建一个封闭的撮合引擎，而在于通过 **Policy Engine** 和 **Reputation Layer**，为所有 Solver（无论内部还是外部）提供一个 **公平、安全、可信的执行环境和标准**。这使得 HIEF 可以利用整个 DeFi 生态的流动性和创新能力，而不是与之竞争。
