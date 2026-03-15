# HIEF Protocol Integration Guide

接入新 DeFi 协议时的完整检查清单，来自 f(x) Protocol 集成过程中踩过的坑。

---

## 快速脚手架

```bash
/add-defi-protocol <ProtocolName>
```

Claude Code skill 会生成 adapter 骨架。生成后，按以下清单逐项补全。

---

## Checklist

### ✅ 1. Token Registry

**文件**：`packages/agent/src/tools/tokenRegistry.ts`

新协议涉及的所有 token，**必须同时加到两个数组**：

```typescript
// MAINNET_TOKENS — chainId: 1
{ symbol: 'TOKEN', name: '...', address: '0x...', decimals: 18, chainId: 1, aliases: [...] }

// TENDERLY_TOKENS — chainId: 99917
{ symbol: 'TOKEN', name: '...', address: '0x...', decimals: 18, chainId: 99917, aliases: [...] }
```

> **坑**：只加一个 → `resolveToken(symbol, chainId)` 返回 null → "Unknown token" → intent 链静默失败，无明显报错。

---

### ✅ 2. allCalls 多步交易

协议操作有 approve + action 两步时，`quote()` 返回值必须包含 `allCalls: CallData[]`：

```typescript
const allCalls: CallData[] = [
  { to: tokenAddress, value: 0n, data: approveData, description: 'Approve TOKEN' },
  { to: protocolAddress, value: 0n, data: actionData, description: 'Open Position' },
];
return { ..., allCalls };
```

**执行模型**（server.ts 已通用化，adapter 只管返回正确 allCalls）：

| 模式 | 执行方式 |
|------|----------|
| EOA / Direct | 逐条顺序 `sendRaw()`，approve confirm 后再估 gas 执行下一步 |
| Safe Multisig | MultiSend 打包，`tenderly_simulateBundle` 整体模拟 |
| ERC-4337 | UserOperation 打包，`tenderly_simulateBundle` 整体模拟 |

> **坑**：跳过 approve 直接执行 → revert；只模拟最后一条 tx → 模拟结果不准。

---

### ✅ 3. Gas 估算

**禁止 hardcode gasLimit**。框架已通用化（`sendRaw` 自动 `eth_estimateGas` + 25% buffer），adapter 无需处理。

但接入后需验证：
- 在 Tenderly fork 上跑一次完整模拟，确认 gas 在合理范围
- f(x) leverage：800k–1.2M gas（比普通 swap 多 10 倍）
- Safe execTransaction：仿真总 gas + 50k overhead × 1.3

---

### ✅ 4. Fork RPC vs Mainnet RPC（外部 SDK）

如果协议有官方 SDK（如 `FxSdk`、`AaveV3SDK`）需要读链上状态构建 calldata：

```typescript
// ✅ 正确：FORK 模式用 fork RPC，MAINNET 用主网 RPC
const rpcUrl = params.routingMode === 'FORK'
  ? (params.rpcUrl || MAINNET_RPC_URL)
  : MAINNET_RPC_URL;

const sdk = new ProtocolSdk({ rpcUrl, chainId: 1 }); // chainId 始终为 1（fork 镜像主网合约地址）
```

> **坑**：始终用 mainnet RPC → calldata 基于主网状态 → fork 链上价格/流动性不同 → revert。LONG 可能碰巧工作（不敏感），SHORT 一定失败（fxUSD 流动性不同）。

**例外**：fxSAVE deposit/withdraw 保持 mainnet RPC（fork 的 epoch 可能过期）。

---

### ✅ 5. 多 collateral 仓位：明确 approve token

协议有多种仓位类型时，确认每种仓位实际传入合约的 token：

| 仓位 | Collateral token | Approve 对象 |
|------|-----------------|-------------|
| f(x) LONG | wstETH / WBTC | wstETH / WBTC |
| f(x) SHORT | fxUSD（无论什么市场）| fxUSD |
| Aave DEPOSIT | depositToken | depositToken |

> **坑**：SHORT 建仓时 approve 了 WBTC，但合约实际 `transferFrom` 的是 fxUSD → revert，simulation 也显示失败。

---

### ✅ 6. Faucet Tokens 声明

在 adapter 中声明 `faucetTokens`，框架启动时自动合并进 `/faucet`：

```typescript
class MyProtocolAdapter implements DefiProtocolAdapter {
  faucetTokens: FaucetTokenDef[] = [
    { symbol: 'TOKEN_A', address: '0x...', decimals: 18, defaultAmount: '1000' },
    { symbol: 'TOKEN_B', address: '0x...', decimals: 8,  defaultAmount: '0.1' },
  ];
}
```

> **坑**：不声明 → faucet 没有对应 token → 测试钱包无法获取 → 手动添加。

---

### ✅ 7. CallData descriptions（多步交易）

`allCalls` 每条必须有 `description`，用于 simulation 结果展示：

```typescript
{ to: ..., value: 0n, data: approveData, description: `Approve ${tokenSymbol}` },
{ to: ..., value: 0n, data: actionData,  description: `Open 2x Long ${tokenSymbol} (${market})` },
```

---

### ✅ 8. receipt.status 检查

框架已通用化（`sendRaw` 内检查 `receipt.status === 0`），adapter 无需处理。

但如果 adapter 自己调用 RPC，必须检查：
```typescript
if (receipt.status === 0) throw new Error(`Transaction reverted: ${hash}`);
```

> **坑**：Tenderly fork 上交易被 mine 不等于成功，status=0 表示 revert。

---

## 典型 adapter 骨架

```typescript
export class MyProtocolAdapter implements DefiProtocolAdapter {
  readonly id = 'my-protocol';
  readonly name = 'My Protocol';

  // ✅ Checklist item 6
  faucetTokens: FaucetTokenDef[] = [
    { symbol: 'TOKEN_A', address: '0x...', decimals: 18, defaultAmount: '100' },
  ];

  async quote(params: QuoteParams): Promise<DefiSkillQuote | null> {
    const { tokenIn, amountIn, routingMode, rpcUrl } = params;

    // ✅ Checklist item 4: fork-aware SDK init
    const sdkRpc = routingMode === 'FORK' ? (rpcUrl || MAINNET_RPC) : MAINNET_RPC;
    const sdk = new ProtocolSdk({ rpcUrl: sdkRpc, chainId: 1 });

    const route = await sdk.buildRoute(tokenIn, amountIn);

    // ✅ Checklist item 2 + 7: allCalls with descriptions
    const allCalls: CallData[] = [
      { to: tokenIn, value: 0n, data: encodeApprove(...), description: `Approve ${symbol}` },
      { to: route.to, value: 0n, data: route.data,        description: `Deposit to My Protocol` },
    ];

    return { skill: 'DEPOSIT', tokenIn, tokenOut, amountIn, amountOut, allCalls };
  }
}
```

---

## 注册协议

在 `packages/solver-network/src/server.ts` 找到 `defiRegistry.register(...)` 的地方：

```typescript
import { MyProtocolAdapter } from './adapters/myProtocol';
defiRegistry.register(new MyProtocolAdapter());
```

`server.ts` 无需其他修改，路由和 faucet 均自动处理。
