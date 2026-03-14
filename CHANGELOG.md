# HIEF Intent Infrastructure — Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added — f(x) Protocol leveraged positions + adaptive routing (2026-03-15)

**New skill types**: `LEVERAGE_LONG`, `LEVERAGE_SHORT`, `LEVERAGE_CLOSE` — open/increase/close leveraged positions on wstETH (ETH market) and WBTC (BTC market) via f(x) Protocol.

**Adaptive routing design** (generalizable to any future adapter):
- `QuoteParams` gets `routingMode: 'MAINNET' | 'FORK'`; server sets it from `SETTLEMENT_CHAIN_ID !== 1`
- Each adapter self-selects routes based on `routingMode` — no per-protocol routing logic in server
- FX Protocol: `FORK` → `['FxRoute', 'FxRoute 2']` (pure on-chain, no Odos/Velora API); `MAINNET` → SDK picks best

**Changes in `packages/solver-network/src/defiSkills.ts`:**
- `DefiSkillType`: + `LEVERAGE_LONG | LEVERAGE_SHORT | LEVERAGE_CLOSE`
- `QuoteParams`: + `routingMode?`, `leverageMultiplier?`, `positionId?`, `market?`
- `DefiSkillQuote`: + `allCalls?: CallData[]` (pre-packed multi-tx) + `leverageInfo?`
- Registry `buildCalls()`: short-circuits to `allCalls` if pre-packed
- FX `skillMarket.register`: updated skills + wstETH + WBTC in `supportedTokens`

**Changes in `packages/solver-network/src/adapters/fxProtocol.ts`:**
- Added `_quoteLeverageLong`, `_quoteLeverageShort`, `_quoteLeverageClose`
- Uses `sdk.increasePosition()` / `sdk.reducePosition()` from `@aladdindao/fx-sdk`
- `forkSafeTargets(routingMode)`: FORK → `['FxRoute', 'FxRoute 2']`, MAINNET → undefined (SDK chooses)
- `ROUTE_TYPES` not exported by SDK → string literals used (match SDK internal values)

**Changes in `packages/solver-network/src/server.ts`:**
- `getIntentSkillType`: + LEVERAGE_LONG/SHORT/CLOSE in DEFI_SKILLS
- Passes `routingMode`, `leverageMultiplier`, `positionId`, `market` to adapter

**Changes in `packages/agent/src/parser/intentParser.ts`:**
- `IntentType`, Zod schema, `SUPPORTED_TYPES`: + three leverage types
- `isLeverage` flag; uiHints propagates `leverage`, `market`, `positionId` from LLM `extraParams`

**Changes in `packages/agent/src/prompts/systemPrompt.ts`:**
- Rule 3e: leverage parsing (protocol="fx", market inference, extraParams format)
- Two new few-shot examples: wstETH 2x long, WBTC 2x short

**Changes in `packages/agent/src/conversation/conversationEngine.ts`:**
- Leverage confirmation template (detects from `tags[0]`, shows leverage multiplier + market)

**Changes in `apps/explorer/index.html`:**
- "2x long wstETH (f(x))" and "2x short WBTC (f(x))" quick suggestion buttons

---

### Changed — Default Tenderly fork to HIEFMainnetFork2 + localStorage persistence (2026-03-15)

**New fork**: `HIEFMainnetFork2` — `https://virtual.mainnet.eu.rpc.tenderly.co/4a595ca5-c96a-4ad8-aeb6-b789648f9880` (chainId 99917). Previous fork had expired fxSAVE pool epoch.

**Changes in `packages/solver-network/src/server.ts`:**
- `TENDERLY_RPC_URL` default updated to new fork URL (still overridable via `TENDERLY_RPC_URL` env var or `POST /v1/solver-network/config`)

**Changes in `apps/explorer/index.html`:**
- Quick preset button updated: "HIEFMainnetFork2 (99917)"
- `saveForkConfig()`: on success, saves `hief_fork_rpc` + `hief_fork_chainid` to `localStorage` so the configured fork persists across page reloads
- `loadConfig()`: reads `localStorage` on page load; if a saved fork exists, pushes it to the server (overrides server default) — the user-configured fork survives both browser refresh and server restart

**User workflow**: Open fork config (⚙ button) → enter new URL → Apply → that URL becomes the default. No need to re-enter after page refresh or server restart.

---

### Fixed — FxSdk uses stale Tenderly fork state, FxUSDBasePool.previewDeposit reverts "expired" (2026-03-15)

**Root cause**: The `FxProtocolAdapter` passed the Tenderly fork RPC URL to `FxSdk`. The fxSAVE pool (`FxUSDBasePool`) has epoch-based reward periods — when the fork is pinned to an old block, the epoch expires and `previewDeposit` reverts with `"expired"`. This caused every fxSAVE quote to silently return `null` → "no valid quotes found".

**Key insight**: `FxSdk` is only used to BUILD calldata (reads slippage, exchange rates, minShares). The generated calldata (contract addresses, ABI-encoded function calls) is the same on both mainnet and the fork. There is no reason to use the fork RPC for quote building — live mainnet state is always more reliable.

**Changes in `packages/solver-network/src/adapters/fxProtocol.ts`:**

- Added `MAINNET_RPC_URL` constant: `process.env.MAINNET_RPC_URL ?? 'https://ethereum-rpc.publicnode.com'`
- `_quoteDeposit` and `_quoteWithdraw`: replaced `new FxSdk({ rpcUrl, chainId: 1 })` with `new FxSdk({ rpcUrl: MAINNET_RPC_URL, chainId: 1 })`
- The `rpcUrl` param from `QuoteParams` (fork URL) is no longer used for calldata building; it remains available for future use if fork-specific reads are needed

**Note on FxSdk singleton**: `FxSdk` uses a module-level singleton client. The first `new FxSdk({ rpcUrl })` call sets the RPC URL for all subsequent instances. Since the server's first FxSdk call now always uses `MAINNET_RPC_URL`, the singleton is always initialized with live mainnet state.

---

### Fixed — Intent parser misroutes fxSAVE to Aave (2026-03-15)

**Root cause**: Three compounding bugs:
1. System prompt had rule 3c for fxSAVE detection but no concrete JSON example → `gpt-4.1-mini` ignored it and returned `protocol: null`, falling to `?? 'aave'` default.
2. `intentParser.ts` output token symbol hardcoded `a${symbol}` prefix for all DEPOSITs regardless of protocol.
3. Solver auction ran all adapters in parallel and selected highest APY — if Aave APY > fxSAVE, Aave won even when user explicitly said "fxSAVE".

**Changes:**

`packages/agent/src/prompts/systemPrompt.ts`:
- Added concrete JSON examples for "deposit 100 USDC to fxSAVE" and "withdraw 50 USDC from fxSAVE" showing `protocol: "fx"`, `outputToken: "fxSAVE"` / `"USDC"` — few-shot examples are the most reliable way to teach `gpt-4.1-mini` edge cases.

`packages/agent/src/parser/intentParser.ts`:
- Output token symbol is now protocol-aware: `protocol === 'fx'` → `outputTokenSymbol = 'fxSAVE'` instead of `aUSDC`.

`packages/agent/src/conversation/conversationEngine.ts`:
- `buildFallbackConfirmation` and `buildExecutionMessage`: Added `isFxSave` and `isLido` branches so confirmation messages show the correct protocol name and receipt token. Previously all DEPOSITs showed "Aave v3".

`packages/solver-network/src/server.ts`:
- Auction now filters solvers by `intent.meta.uiHints.protocol` before running. When user says "fxSAVE", only `fx-protocol` adapter is invited; Aave is excluded. Filter is bypassed for SWAP intents and when protocol is `'auto'`.

---

### Added — DeFi Skill Market + FX Protocol (fxSAVE) adapter (2026-03-15)

**Architecture: Open DeFi Skill Market**

HIEF now defines a two-layer plugin model:
- **`DefiProtocolAdapter`** (existing): on-chain execution interface — `quote()` + `buildCalls()`
- **`SkillManifest`** (new): off-chain metadata layer — version, tokens, chains, skill source URL

Any DeFi protocol can publish a `SKILL.md` (like [fx-sdk-skill](https://github.com/AladdinDAO/fx-sdk-skill)) and integrate into HIEF by implementing the adapter. Goal: upgrade from "AI wallet" to **open AI DeFi Intent Infrastructure**.

**New files:**

`packages/solver-network/src/skillMarket.ts`:
- `SkillManifest` interface: `id`, `name`, `version`, `description`, `skillSourceUrl`, `supportedSkills`, `supportedTokens`, `chainIds`, `sdk?`, `author?`
- `SkillMarket` singleton: `register(manifest, adapter)`, `list()`, `get(id)`

`packages/solver-network/src/adapters/fxProtocol.ts`:
- `FxProtocolAdapter` — first third-party skill integration
- Uses `@aladdindao/fx-sdk` v1.0.5: `FxSdk.depositFxSave()` / `withdrawFxSave()` / `getFxSaveConfig()`
- DEPOSIT: USDC → fxSAVE (approve + deposit via SDK)
- WITHDRAW: fxSAVE → USDC (converts shares via `totalAssetsWei / totalSupplyWei` exchange rate, instant=true)
- Supported tokens: USDC + fxUSD

`.claude/skills/fx-protocol/SKILL.md`:
- HIEF-format Claude Code skill — references upstream `https://github.com/AladdinDAO/fx-sdk-skill`

**Modified files:**

`packages/solver-network/src/defiSkills.ts`:
- Added `skillSource?: string` field to `DefiProtocolAdapter` interface
- Registers FX Protocol via `skillMarket.register()`

`packages/solver-network/src/server.ts`:
- `GET /v1/solver-network/skills` — list all registered skill manifests
- `GET /v1/solver-network/skills/:id` — detail for one manifest

`packages/solver-network/package.json`:
- Added `@aladdindao/fx-sdk: ^1.0.5`

`packages/agent/src/prompts/systemPrompt.ts`:
- Added f(x) Protocol to supported protocols and intent recognition rules

`apps/explorer/index.html`:
- Added "deposit 100 USDC to fxSAVE" and "withdraw 50 USDC from fxSAVE" quick suggestion buttons

---

### Refactored — Remove all auto-funding from tx paths, add /faucet endpoint (2026-03-14)

**Root cause**: `tenderly_setBalance` / `tenderly_setErc20Balance` RPC calls were appearing as state-mutation transactions in the Tenderly fork explorer, polluting the real transaction history and masking actual DeFi call behavior.

**Policy**: All auto-funding is removed from `settleOnChain`, `simulateSettlement`, `multisig-collect-signature`, and `safe4337-collect-signature`. If an account lacks funds, the transaction fails — the user funds accounts explicitly via the faucet.

**Changes in `packages/solver-network/src/server.ts`:**

- `settleOnChain`: Completely rewritten to use `hardhat_impersonateAccount` + `eth_sendTransaction` for user addresses (EOA/Safe), with a `sendRaw` helper that dispatches to either impersonated RPC or settlement wallet.
- Removed `tenderly_setBalance` / `tenderly_setErc20Balance` from all execution paths.
- `simulateSettlement`: Removed pre-funding block guarded by `ENABLE_TENDERLY_AUTOFUND`.
- `multisig-collect-signature`: Removed Safe pre-funding.
- `safe4337-collect-signature`: Removed Safe pre-funding.
- Added `FAUCET_TOKENS` constant (ETH, WETH, USDC, USDT, DAI).
- Added `POST /v1/solver-network/faucet` endpoint — explicit, user-triggered only.

---

### Added — Default EOA wallet + Faucet UI panel (2026-03-14)

**Changes in `apps/explorer/index.html`:**

- Default `chatWallet` changed to `0x7d73932636FbC0E57448BA175AbCd800C60daE5F`
- Added collapsible faucet panel with:
  - Address input (pre-filled when opened from a wallet card)
  - Per-token checkboxes + amount inputs: ETH (0.5), USDC (1000), WETH (1), USDT (1000), DAI (1000)
  - "💧 Fund Address" button calls `POST /v1/solver-network/faucet`
- Wallet cards now show "💧 Faucet" button to open panel pre-filled with that wallet's address
- New JS functions: `toggleFaucetPanel`, `hideFaucetPanel`, `openFaucetForAddress`, `faucetUseSelectedWallet`, `doFaucet`, `setFaucetStatus`

**Changes in `packages/solver-network/src/server.ts`:**

- `TEST_WALLETS` EOA address updated to `0x7d73932636FbC0E57448BA175AbCd800C60daE5F`

---

### Fixed — EOA DIRECT mode uses settlement wallet instead of user address (2026-03-14)

**Root cause**: The DIRECT execute handler did not pass the user's address to `settleOnChain`. Additionally, ethers v6 `provider.getSigner(address)` fails for impersonated accounts not in `eth_accounts`, throwing "invalid account".

**Fix**: Replaced `provider.getSigner()` + `.sendTransaction()` with direct `provider.send('eth_sendTransaction', [{from, to, data, value, gas}])` RPC call. Tenderly honors `hardhat_impersonateAccount` at the RPC level; ethers account validation is bypassed entirely.

**Changes in `packages/solver-network/src/server.ts`:**

- DIRECT execute handler: `userAddr = intent.sender || intent.smartAccount || accountInfo?.address` passed to `settleOnChain`
- `settleOnChain`: unified impersonated + settlement-wallet paths via `sendRaw` helper
- `simOverride` now applies to all wallet modes (previously only MULTISIG / ERC4337_SAFE)

---

### Fixed — Safe4337 UserOperation callGasLimit too low for USDC deposit (2026-03-14)

**Root cause**: `callGasLimit = 200_000` insufficient for the full Safe4337 call chain: `executeUserOp → execTransactionFromModule → MultiSend → approve + Pool.supply` (~260k gas).

**Changes in `packages/solver-network/src/safe4337.ts`:**

- `callGasLimit`: `200_000n` → `500_000n`
- Error message now includes both UserOpHash and handleOps txHash:
  `UserOperation failed on-chain. UserOpHash: ${userOpHash} | handleOps txHash: ${receipt.hash}`

---

### Fixed — Aave ERC-20 WITHDRAW: use hardhat_impersonateAccount (2026-03-14)

**Root cause (v2)**: The DEPOSIT credits aTokens to `intent.smartAccount` (user's wallet), NOT the
settlement wallet. Any approach that pre-funds the settlement wallet with aTokens is fundamentally
wrong. Fix: impersonate the user's smart account on the Tenderly fork to execute the withdrawal from
the account that actually holds the aTokens.

**Changes in `packages/solver-network/src/server.ts`:**

- `settleOnChain`: ERC-20 WITHDRAW now impersonates `intent.smartAccount` on the Tenderly fork
  (`hardhat_impersonateAccount` / `hardhat_stopImpersonatingAccount`), gives it 0.1 ETH for gas,
  then calls `Pool.withdraw` from the user's own account. Removed the pre-supply approach.
- `simulateSettlement`: ERC-20 WITHDRAW simulation now uses `from: intent.smartAccount` directly
  (single-tx). The user's smart account holds real aUSDC after the prior DEPOSIT, so the simulation
  passes without any pre-funding. Removed the 3-tx bundle approach.

---

### Fixed — Aave ERC-20 WITHDRAW revert on Tenderly fork (2026-03-14)

**Root cause**: `tenderly_setErc20Balance` silently fails for aTokens (scaled balance storage), leaving
the settlement wallet with 0 aUSDC. `Pool.withdraw` then reverts with empty reason data.

**Changes in `packages/solver-network/src/server.ts`:**

- `settleOnChain`: Added a `WITHDRAW` ERC-20 pre-supply step — funds wallet with underlying (e.g. USDC),
  approves it to Aave Pool, calls `Pool.supply()` to acquire real aTokens on the fork, then proceeds
  with the existing `Pool.withdraw()` calldata which now succeeds.
- `simulateSettlement`: Fixed pre-funding to use underlying token (not aToken) for all WITHDRAW cases.
  Added a 3-tx bundle path for ERC-20 WITHDRAW simulation: `approve(underlying) → supply → withdraw`.
  Previously the single-tx path sent `Pool.withdraw` without aToken balance, causing every WITHDRAW
  simulation to fail before user even confirmed.

---

### Added — Lido protocol adapter (STAKE / UNSTAKE) (2026-03-14)

**New adapter: `LidoAdapter` in `packages/solver-network/src/defiSkills.ts`**

| Skill | Flow | Contract |
|---|---|---|
| STAKE | ETH → stETH via `Lido.submit(referral)` payable | `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84` |
| UNSTAKE | stETH → ETH withdrawal request via `WithdrawalQueue.requestWithdrawals` | `0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1` |

- STAKE: no approval needed — ETH sent as `msg.value`
- UNSTAKE: approve stETH to WithdrawalQueue first; queues withdrawal NFT (~1-4 day claim delay)
- APR fetched live from Lido API, fallback 3.5%
- Auto-registered: `defiRegistry.register(new LidoAdapter())`
- Supported chains: Ethereum mainnet (1) + local fork (31337)

**Intent parser / agent (`packages/agent/src/`):**
- `STAKE` and `UNSTAKE` added to supported intent types (alongside SWAP/DEPOSIT/WITHDRAW)
- `stETH` added to mainnet token registry
- System prompt updated: STAKE/UNSTAKE description + rule 3d
- `parseAndResolve`: STAKE/UNSTAKE follow same 1:1 semantics (slippageBps=0, minOutput=inputAmount, protocol=lido)

**Explorer UI:** added `stake 0.5 ETH on Lido` quick suggestion button

**Test count: 86 passing (policy 12 + agent 28 + solver-network 46)**

---

### Added — solver-network DeFi skill unit tests (2026-03-14)

New test file: `packages/solver-network/src/__tests__/defiSkills.test.ts` (30 tests)

| Suite | Coverage |
|---|---|
| `DefiSkillRegistry` | register/unregister, getById, getForSkill, getForToken, buildCalls dispatch, generic fallback |
| `AaveV3Adapter.supportsToken` | ETH alias, USDC, WETH, aToken, unknown token, case-insensitive, wrong skill |
| `AaveV3Adapter.buildCalls` | DEPOSIT ERC-20 (approve+supply), DEPOSIT ETH (no approve, value), WITHDRAW ERC-20 (no approve), WITHDRAW ETH (approve aWETH + withdrawETH) |
| `AaveV3Adapter.quote` (APY mocked) | DEPOSIT USDC/ETH, WITHDRAW USDC/aUSDC/WETH, unsupported token, STAKE, calldata ABI decode verification |
| Global `defiRegistry` | AaveV3Adapter pre-registered, skills, chains |

No live RPC calls — `_fetchApy` is spied on and returns a fixed 4.5%.

---

### Fixed — Policy engine false positives for DeFi intents (2026-03-14)

**R9 (ETH drain) — false positive on ETH DEPOSIT:**
- `DEPOSIT`/`STAKE`/`WITHDRAW` intents intentionally send ETH to a protocol; they must not trigger R9
- Fix: detect DeFi skill intents via `meta.tags[0]` ∈ `DEFI_SKILL_TAGS`; when no explicit `maxSpend` is set, use `intent.input.amount` as the implicit ceiling
- Result: ETH value ≤ input amount → R9 passes; ETH value > input amount → R9 fires HIGH

**R8 (protocol whitelist) — Aave v3 flagged as unknown:**
- Added Aave v3 Pool (`0x87870...`) and WETHGateway (`0xD322A...`) to `WHITELISTED_PROTOCOLS` in `packages/common/src/config/index.ts`

**Tests added (`packages/policy/src/__tests__/policy.test.ts`):**
- R9 PASS: ETH DEPOSIT value = input amount (no false positive)
- R9 FAIL: ETH DEPOSIT value > input amount (correctly flagged)
- R8 PASS: Aave v3 Pool calls no longer produce MEDIUM warning

---

### Added — Agent parser tests for DEPOSIT/WITHDRAW (2026-03-14)

New test cases in `packages/agent/src/__tests__/agent.test.ts`:
- `parseAndResolve` DEPOSIT: USDC, ETH, null outputToken, Chinese input ("存100 USDC 到 Aave")
- `parseAndResolve` WITHDRAW: USDC, ETH, Chinese input ("从 Aave 取出 0.1 ETH")
- Error cases: unknown token for DEPOSIT, STAKE returns "not yet supported"
- Key assertions: `slippageBps=0`, `outputs[0].token` is placeholder for DEPOSIT but underlying for WITHDRAW, `meta.tags[0]` correctness

Total: 27 tests passing (was 22).

---

### Fixed — Explorer UI simulation failure display (2026-03-14)

`showSimulationCard` in `apps/explorer/index.html`:
- When `sim.success === false`, shows a red warning banner above the execute button
- Execute buttons across all modes (DIRECT/MULTISIG/ERC4337/Safe4337) change to warning style (`⚠️ Execute Anyway (Sim Failed)`) instead of normal action style
- Previously the UI showed the error message but the button gave no visual indication of the failure risk

---

### Fixed — Simulation error propagation (2026-03-14)

`simulateSettlement` now captures and surfaces simulation errors in the returned `SimulationResult.error` field.

**Changes (`packages/solver-network/src/server.ts`):**
- Bundle path (MULTISIG/ERC4337): distinguish top-level RPC error from per-tx revert; extract `failed?.error?.message || failed?.revert_reason` on revert
- Single-tx path: same pattern — set `simSuccess=false` and populate `simError` on RPC error or `status !== true`
- Return: `...(simError && { error: simError })` appended to `SimulationResult`

Previously the `error?: string` field on `SimulationResult` was never populated — callers could not distinguish a reverted simulation from a successful one without re-checking `success: false`.

---

### Fixed — Aave WITHDRAW "invalid address" crash (2026-03-14)

**Bug:** `withdraw 50 USDC from Aave` via Safe Multisig threw during solver auction:
```
Solver auction error: invalid address (argument="address", value="")
```

**Root cause:** `needsApproval` in `AaveV3Adapter._quoteWithdraw` was `!isEth` (inverted).
For ERC-20 WITHDRAW: `isEth=false` → `needsApproval=true` + `approveTarget=''` → `buildCalls` tried `approve('', amount)` → ethers threw invalid address.

| Path | Was | Correct |
|------|-----|---------|
| ERC-20 WITHDRAW (`Pool.withdraw`) | `needsApproval=true`, `approveTarget=''` | `needsApproval=false` — Pool calls `aToken.burn(msg.sender)` directly, no transferFrom |
| ETH WITHDRAW (`WETHGateway.withdrawETH`) | `needsApproval=false` | `needsApproval=true` — Gateway calls `aWETH.transferFrom(msg.sender, ...)`, needs approve |

**Fix:** `packages/solver-network/src/defiSkills.ts`: `needsApproval: !isEth` → `needsApproval: isEth`

---

### Added — DeFi Protocol Plugin System + Aave v3 DEPOSIT/WITHDRAW (2026-03-14)

#### Plugin Architecture (`packages/solver-network/src/defiSkills.ts`)

New extensible registry replacing the previous hardcoded Aave-specific logic.
Adding a new DeFi protocol now requires **zero changes to `server.ts`**.

| Export | Description |
|--------|-------------|
| `DefiProtocolAdapter` | Interface every protocol adapter must implement |
| `QuoteParams` | Input to `adapter.quote()` — skill, tokenIn, amountIn, recipient, rpcUrl |
| `DefiSkillQuote` | Output — calldata, needsApproval, receiptTokenIn, apy, route, etc. |
| `CallData` | `{ to, value, data }` — one call in a multi-call sequence |
| `DefiSkillRegistry` | Singleton with `register()`, `getAll()`, `getForSkill()`, `buildCalls()` |
| `defiRegistry` | Exported singleton — import and call `.register(new MyAdapter())` |
| `AaveV3Adapter` | Built-in adapter: DEPOSIT + WITHDRAW for Aave v3 on Ethereum mainnet |

**To add a new protocol:**
```typescript
// 1. Implement the interface
class CompoundV3Adapter implements DefiProtocolAdapter { ... }
// 2. Register — server.ts auto-discovers it
defiRegistry.register(new CompoundV3Adapter());
// 3. Done — solver persona auto-generated, routing protocol-agnostic
```

#### Aave v3 WITHDRAW (`AaveV3Adapter`)

| Field | DEPOSIT | WITHDRAW |
|-------|---------|---------|
| Calldata | `Pool.supply(asset, amount, onBehalfOf, 0)` | `Pool.withdraw(asset, amount, to)` |
| needsApproval | `true` (USDC → Pool) | `false` (Pool burns aTokens from msg.sender) |
| ETH variant | `WETHGateway.depositETH(...)` | `WETHGateway.withdrawETH(...)` (approval needed) |
| `receiptTokenIn` | — | aToken address (e.g. aUSDC) — used for simulation funding |

**Simulation & settlement pre-funding:** For WITHDRAW, the caller must hold **aTokens** (not the underlying). Pre-funding now correctly funds `skillQ.receiptTokenIn` instead of `intent.input.token` in all three paths: `simulateSettlement`, `settleOnChain` (DIRECT), and Safe MULTISIG collect-signature.

#### `server.ts` — protocol-agnostic routing

- `SOLVER_PERSONAS` now auto-generated from `defiRegistry.getAll()` — no manual entry needed per protocol
- `isDepositIntent` → `isDeFiSkillIntent` + `getIntentSkillType` — handles any `DefiSkillType`
- `generateQuote` DeFi path: dispatches to `adapter.quote({skill, tokenIn, amountIn, ...})` via registry
- `buildWinnerTxParams`: uses `defiRegistry.buildCalls(skillQ)` (was: `buildAaveDepositCalls`)
- SWAP path: rejects DeFi adapter solvers via `defiRegistry.getAll().some(a => a.name === solver.protocol)`

#### `intentParser.ts` + `systemPrompt.ts`

- WITHDRAW intent now supported (was: blocked with "not supported" error)
- Output token for WITHDRAW = input token (user gets their asset back, 1:1)
- `slippageBps = 0` for WITHDRAW (same as DEPOSIT — lending is 1:1, no slippage)
- System prompt: added WITHDRAW example + guidance for `outputToken` resolution (3b)

#### Claude Code Skill: `add-defi-protocol`

Location: `.claude/skills/add-defi-protocol/SKILL.md`

A development-time Claude Code slash command. When a developer runs `/add-defi-protocol Compound v3`, Claude:
1. Reads the `DefiProtocolAdapter` interface and `AaveV3Adapter` as reference
2. Asks for contract addresses and supported tokens
3. Generates a complete `<Name>Adapter` TypeScript class
4. Registers it in `defiRegistry`
5. Runs TypeScript compile check
6. Updates Explorer UI quick suggestions

> **Key concept:** The skill generates code; the TypeScript adapter is what actually runs. The skill is a development accelerator, not a runtime component.

#### Explorer UI (`apps/explorer/index.html`)

- Added "withdraw 50 USDC from Aave" to Quick Suggestions

---

### Added — Aave v3 DEPOSIT Integration (2026-03-13)

#### Features

- **Aave v3 DEPOSIT intent** — AI parses "deposit 100 USDC to Aave" → on-chain `Pool.supply()` execution
- **Two-step approve + supply UI** — approve tx hash shown as "Step 1", supply tx as "Step 2"
- **Live APY display** — fetched from `Pool.getReserveData().currentLiquidityRate` (RAY → %)
- **`tenderly_simulateBundle`** — approve + supply simulated atomically on Tenderly fork
- **`buildWinnerTxParams()` helper** — single source of truth for Safe/UserOp calldata (replaces 4 hardcoded WETH fallbacks)
- **`ENABLE_TENDERLY_AUTOFUND` guard** — all `tenderly_setErc20Balance` / `tenderly_setBalance` calls gated; safe to deploy on non-fork networks
- **Recent inputs history** — last 5 inputs saved to `localStorage` key `hief_recent_inputs`, shown as amber chip buttons above Quick Suggestions

#### Files Changed

| File | Change |
|------|--------|
| `packages/solver-network/src/defiSkills.ts` | New file — Aave v3 adapter (later refactored to plugin system) |
| `packages/solver-network/src/server.ts` | Aave routing, simulation bundle, approve tx hash, buildWinnerTxParams, autofund guard |
| `packages/agent/src/parser/intentParser.ts` | DEPOSIT intent support |
| `packages/agent/src/prompts/systemPrompt.ts` | DEPOSIT examples and guidance |
| `apps/explorer/index.html` | Two-step approve/supply UI, recent inputs history, Aave quick suggestion |

---

### Added
- **Real DEX solver integration** — solver auction now queries live DEX protocols:
  - **Odos Aggregator** — multi-hop routing across Uniswap, Curve, Balancer, 100+ sources via Odos API (free, no key)
  - **Uniswap V3 Direct** — on-chain QuoterV2 quote (0.05%/0.3%/1% fee tiers) + SwapRouter02 calldata
  - **HIEF Native** — fallback to best available on-chain route
- **Real swap calldata in execution plans** — winning quote's `approve + swap` calldata embedded in Safe Multisig proposal and ERC-4337 UserOp so the Safe actually executes the real DEX trade on-chain
- **Real DIRECT settlement** — settlement wallet auto-funded via `tenderly_setErc20Balance`, executes actual swap
- **Accurate simulation output** — uses real DEX `amountOut` instead of estimated WETH mock amounts
- **MultiSend encoding** (`dexQuoters.ts`) — `approve + swap` wrapped atomically via `MultiSendCallOnly`
- `safeMultisig.ts`: `proposeSafeMultisig` now accepts `operation` parameter for DELEGATECALL support

### Fixed
- **chainId=1 signing error** — `buildUserOpTypedData` no longer fetches chainId from the Tenderly RPC (Tenderly virtual testnets can return the underlying mainnet chainId=1 instead of the fork chainId); now always uses the configured `SETTLEMENT_CHAIN_ID`
- **MetaMask chain preflight** — before signing Safe TX or UserOp, the explorer checks `eth_chainId` and calls `wallet_switchEthereumChain` if MetaMask is on the wrong chain; shows a clear error if the switch is rejected

### Added
- **Session/wallet mismatch warning** in AI DeFi Agent — when the active wallet address differs from the session's wallet, a yellow warning banner is shown with a "Start New Session" button; triggered on test wallet selection, created wallet selection, and manual chatWallet input edits
- **Test Wallets Panel** in Explorer UI — three pre-configured accounts covering all execution modes
- **Tenderly Fork Config Panel** in Explorer UI — display and edit RPC URL + Chain ID at runtime
- **`ENABLE_TENDERLY_AUTOFUND` guard** — auto-fund is now opt-in via environment variable
- **`/v1/solver-network/config` GET/POST** — runtime configuration API for fork URL and chain ID
- **`/v1/solver-network/test-wallets` GET** — returns pre-configured test wallet info with live ETH balances
- **`/v1/solver-network/fund-test-wallet` POST** — funds a test wallet via `tenderly_setBalance` (requires `ENABLE_TENDERLY_AUTOFUND=true`)

---

## [0.3.0] — 2026-03-12

### Fixed — AA24 Root Cause: EIP-712 Domain Separator

**Root cause:** `Safe4337Module.domainSeparator()` uses `address(this)`. When EntryPoint calls
`validateUserOp` via Safe's fallback handler (CALL, not DELEGATECALL), `address(this)` inside
the module equals the **module address**, not the Safe address.

The EIP-712 typed data domain must therefore use `verifyingContract = SAFE_4337_MODULE_V030`,
not `userOp.sender` (the Safe address).

**Files changed:**

| File | Change |
|------|--------|
| `packages/solver-network/src/safe4337.ts` | `buildUserOpTypedData`: `verifyingContract` = module address (was: Safe address) |
| `packages/solver-network/src/safe4337.ts` | `submitSafe4337UserOp`: fix `UserOperationEvent` v0.7 ABI decode (data = `[nonce, bool success, actualGasCost, actualGasUsed]`) |
| `packages/solver-network/src/server.ts` | `WETH_ADDRESS` → mainnet `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| `packages/solver-network/src/server.ts` | `USDC_ADDRESS` → mainnet `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| `packages/solver-network/src/server.ts` | `TENDERLY_RPC_URL` default → mainnet fork |
| `packages/solver-network/test_safe4337_e2e.js` | Step 7 status lookup uses `_status` field |

**Verified on Tenderly mainnet fork (chainId 99917):**
- `validateUserOp` returns 0 (success)
- `handleOps` succeeds with `UserOperationEvent.success = true`
- Full E2E: intent → trigger → `/execute` → MetaMask sign → collect → `EXECUTED`
- TxHash: `0x3b49d524e1457d2ce9bc9d4babd9b3cd5c92c4e20061b6b2ceaabf890aaee62c`

---

## [0.2.0] — 2026-03-11

### Added — Safe+Safe4337Module Integration (90% complete)

**Core module:** `packages/solver-network/src/safe4337.ts`

| Export | Description |
|--------|-------------|
| `buildSafe4337UserOperation()` | Builds a `PackedUserOperation` for EntryPoint v0.7 from a Safe + calldata |
| `computeUserOpHash()` | Computes the canonical UserOp hash via `EntryPoint.getUserOpHash()` |
| `buildUserOpTypedData()` | Builds EIP-712 typed data for MetaMask `eth_signTypedData_v4` |
| `executeSafe4337WithSignature()` | Submits signed UserOp to EntryPoint, waits for `UserOperationEvent` |
| `getSafe4337AccountInfo()` | Detects if an address is a Safe with Safe4337Module enabled |
| `SAFE_4337_MODULE_V030` | `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` |
| `ENTRY_POINT_V07` | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |

**Server integration:** `packages/solver-network/src/server.ts`

| Feature | Description |
|---------|-------------|
| `detectAccountMode()` | Now returns `ERC4337_SAFE` for Safes with Safe4337Module enabled |
| `/v1/solver-network/trigger` | ERC4337_SAFE branch: builds UserOp, caches typed data for MetaMask |
| `/v1/solver-network/execute/:intentId` | Returns `userOpTypedData` for MetaMask signing |
| `/v1/solver-network/safe4337-collect-signature/:intentId` | Collects user signature, submits UserOp to EntryPoint |

**Frontend:** `apps/explorer/index.html`

| Feature | Description |
|---------|-------------|
| `Safe+4337 Mode` badge | Orange badge for ERC4337_SAFE execution mode |
| `showSafe4337PendingCard()` | Shows UserOp hash and MetaMask sign button |
| `requestSafe4337Signature()` | Calls MetaMask `eth_signTypedData_v4`, submits to `/safe4337-collect-signature` |

**Test:** `packages/solver-network/test_safe4337_e2e.js`

7-step E2E test covering: account verification → intent submit → solver trigger → UserOp build → MetaMask sign simulation → on-chain execution → intent status check.

---

## [0.1.0] — 2026-03-10

### Added — Safe Multisig Integration

**Core module:** `packages/solver-network/src/safeMultisig.ts`

| Export | Description |
|--------|-------------|
| `detectAccountMode()` | Detects DIRECT / MULTISIG / ERC4337 / ERC4337_SAFE for any address |
| `proposeSafeMultisig()` | Builds and signs a Safe transaction (EIP-712), stores pending proposal |
| `buildSafeTxTypedData()` | Builds EIP-712 typed data for Safe TX MetaMask signing |
| `executeWithSignatures()` | Calls `Safe.execTransaction()` with collected signatures |

**Server integration:**

| Feature | Description |
|---------|-------------|
| `/v1/solver-network/trigger` | MULTISIG branch: proposes Safe TX, returns typed data |
| `/v1/solver-network/execute/:intentId` | MULTISIG: returns `multisigProposal` for MetaMask |
| `/v1/solver-network/multisig-collect-signature/:intentId` | Collects co-signer signature, executes Safe TX |

---

## [0.0.1] — 2026-03-08

### Added — Initial MVP

- **Intent Bus** (`apps/intent-bus`): BROADCAST → SELECTED → EXECUTED lifecycle
- **Solver Network** (`packages/solver-network`): 3-solver auction (CoW, UniswapX, HIEF Native)
- **Policy Engine**: intent validation, slippage checks, deadline enforcement
- **Reputation System**: on-chain scoring with 5 dimensions
- **Explorer UI** (`apps/explorer`): address lookup, intent history, live activity, leaderboard, AI Agent chat
- **AI Agent** (`packages/ai-agent`): GPT-4.1-mini intent parsing, session management
- **Direct Settlement**: WETH wrap via `settleOnChain()` on Tenderly fork
- **Tenderly Simulation**: `simulateSettlement()` via `tenderly_simulateTransaction` before every execution

---

## Execution Mode Reference

| Mode | Account Type | Trigger | Execution |
|------|-------------|---------|-----------|
| `DIRECT` | EOA or any | AI signs & broadcasts directly | `settleOnChain()` |
| `MULTISIG` | Gnosis Safe (threshold ≥ 1) | AI proposes Safe TX | Co-signer approves via MetaMask |
| `ERC4337` | ERC-4337 smart account | AI builds UserOp | Bundler submits via EntryPoint v0.6 |
| `ERC4337_SAFE` | Safe + Safe4337Module | AI builds UserOp | User signs with MetaMask → EntryPoint v0.7 → Module → Safe |

## Test Accounts (Tenderly Mainnet Fork, chainId 99917)

| Type | Address | Mode |
|------|---------|------|
| EOA | `0xB67FAfFB8eB9a1972E424bcc51B70Fd6f2d25f8a` | DIRECT |
| Safe Multisig (1-of-2) | `0xbdB26a0a4DCAdcd16b5B3b0F55f0A85D79280aD1` | MULTISIG |
| Safe + Safe4337Module | `0xafde956738f3d610ae93cd4f4d74b029a9d39ebf` | ERC4337_SAFE |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TENDERLY_RPC_URL` | mainnet fork URL | Tenderly fork RPC endpoint (mutable at runtime via `/config`) |
| `SETTLEMENT_CHAIN_ID` | `99917` | Chain ID for EIP-712 signing (mutable at runtime via `/config`) |
| `SETTLEMENT_PRIVATE_KEY` | dev key | AI/solver signing key |
| `ENABLE_TENDERLY_AUTOFUND` | `false` | Set `true` to allow `tenderly_setBalance` auto-funding in dev |
| `WETH_ADDRESS` | mainnet WETH | Override token address |
| `USDC_ADDRESS` | mainnet USDC | Override token address |
| `BUS_URL` | `http://localhost:3001` | Intent Bus URL |
| `PORT` | `3008` | Solver Network port |

## [0.0.4] - 2026-03-12

### Bug Fixes

#### Explorer API "unavailable on port 3006" Error
- **Root cause**: The error message in `lookupAddress()` catch block was hardcoded as "Explorer API unavailable on port 3006." regardless of the actual error. The real cause was typically a JavaScript runtime error (e.g., `createScoreRing` or `createRadar` failing) rather than the API being down.
- **Fix**: Changed the catch block to display the actual error message: `showError('Search failed: ' + err.message)`.

#### Solver Auction Hangs at "Running solver auction & pre-settlement simulation..."
- **Root cause**: The trigger endpoint (`POST /v1/solver-network/trigger`) fetched intent details exclusively from the explorer-api (`localhost:3006`). In some cases, the intent was not yet indexed in the explorer-api's SQLite DB when the trigger was called (race condition between bus write and explorer-api read). This caused a 404 response and the trigger returned an error, but the frontend showed no feedback.
- **Fix**: Added a **bus fallback** in both the trigger endpoint and the poll loop. If explorer-api returns 404, the server now fetches the intent directly from the bus (`BUS_URL/v1/intents/:id`). This eliminates the race condition.

#### Test Wallet Cards Appearing Empty
- **Root cause**: The solver-network server was not restarted after adding the `/test-wallets` endpoint, so the old server (without the endpoint) was still running. The `loadTestWallets()` function silently failed and left the skeleton divs visible.
- **Fix**: Restarted the server with the updated compiled code. The `/test-wallets` endpoint now returns all three wallets with live ETH balances.

### Verified Working
- Trigger endpoint: returns full auction result in ~5s ✅
- Test wallets endpoint: returns 3 wallets with balances ✅
- Error messages: now show actual error instead of hardcoded "port 3006" ✅

---

## [0.0.5] - 2026-03-12

### Bug Fixes

#### Bug 1 — Fork Config Panel Shows "❌ Service starting up" After Switching RPC

- **Root cause**: `gateway.js` does not wait for `solver-network` (port 3008) to be ready before accepting requests. When a new fork URL is applied immediately after startup, the proxy returns `503 ECONNREFUSED` with `{ error: 'Service starting up' }`.
- **Fix** (`apps/explorer/index.html` — `saveForkConfig`): Added automatic retry logic. On `503`, the function waits 3 s and retries up to 3 times, showing `⏳ Retrying... (N/3)`. After 3 failures, displays a friendly `⚠️ Solver service is still starting up. Please wait ~10s and click Apply again.` message instead of a raw error.

#### Bug 2 — EOA Flow Hangs at "Running solver auction & pre-settlement simulation..."

Two independent root causes:

**Server-side** (`packages/solver-network/src/server.ts`):
- **Root cause**: `simulateSettlement()` called `fetch(TENDERLY_RPC_URL, ...)` with no timeout. If the Tenderly fork RPC was slow or unreachable, the request would hang indefinitely, blocking the entire auction.
- **Fix**: Added `signal: AbortSignal.timeout(8000)` to the Tenderly simulation fetch — aborts after 8 s.
- **Root cause 2**: `detectAccountMode()` (ethers.js RPC call to classify EOA/Safe/ERC-4337) had no timeout either.
- **Fix**: Wrapped `detectAccountMode()` in `Promise.race()` with a 6 s rejection timeout in `runAuction()`.

**Frontend-side** (`apps/explorer/index.html` — trigger fetch):
- **Root cause**: The trigger `fetch()` had no timeout and no `else` branch for `success === false`, so failures were silently swallowed.
- **Fix**: Added `AbortController` with 30 s timeout to the trigger fetch. Added `else` branch to display `⚠️ Solver auction error: <message>`. `AbortError` shows a specific message advising to check the Tenderly fork URL.

#### Bug 3 — Safe Multisig Search Fails with "Cannot read properties of null (reading 'getContext')"

- **Root cause**: `createHistory()` used `ctx.canvas.parentElement.innerHTML = '...'` to replace the "No history yet" placeholder. This destroyed the existing `<canvas id="historyChart">` DOM node. On the next call, `document.getElementById('historyChart')` returned `null`, and `.getContext('2d')` threw the error.
- **Fix** (`apps/explorer/index.html`):
  - Added `id="historyChartContainer"` to the canvas wrapper `<div>`.
  - Rewrote `createHistory()`: never destroys the canvas element. Uses `canvas.style.display = 'none'` + a sibling `<div id="historyNoDataMsg">` for the empty state. Calls `historyChartInst.destroy()` before re-creating the Chart.js instance to prevent memory leaks.

### Files Changed

| File | Change |
|------|--------|
| `apps/explorer/index.html` | `saveForkConfig`: retry logic on 503 (Bug 1) |
| `apps/explorer/index.html` | trigger fetch: AbortController 30 s timeout + else branch (Bug 2) |
| `apps/explorer/index.html` | `historyChartContainer` id + `createHistory` canvas lifecycle fix (Bug 3) |
| `packages/solver-network/src/server.ts` | `simulateSettlement`: `AbortSignal.timeout(8000)` on Tenderly fetch (Bug 2) |
| `packages/solver-network/src/server.ts` | `runAuction`: `Promise.race` 6 s timeout on `detectAccountMode` (Bug 2) |

---

## [0.0.6] - 2026-03-12

### Fixed — Solver Auction "Service starting up" on Railway Deployment

**Root cause**: `gateway.js` did not include `solver-network` in the `waitForService` list. On Railway (single-service deployment), the gateway started accepting traffic before `solver-network` (port 3008) was ready, causing every `/v1/solver-network/trigger` call to return `503 ECONNREFUSED` immediately after deploy.

**Fixes:**

- **`gateway.js`**: Added `solver-network` to `waitForService` with a 120 s timeout. Railway's healthcheck will now only pass (and traffic will only be routed) once all services including solver-network are ready.
- **`apps/explorer/index.html`** (trigger fetch): Wrapped the trigger call in a `runTrigger(attempt)` retry function. On `503`, automatically retries up to 3 times with 5 s delay each, showing `⏳ Solver service starting, retrying... (N/3)`.

### Files Changed

| File | Change |
|------|--------|
| `gateway.js` | Add `solver-network` to `waitForService` list (120 s timeout) |
| `apps/explorer/index.html` | Trigger fetch: `runTrigger(attempt)` retry on 503, up to 3× with 5 s delay |

---

## [0.0.7] - 2026-03-12

### Fixed — solver-network Crashes on Railway (Missing Compiled Files)

**Root cause**: `packages/solver-network/dist/` was committed to git but only contained `safeMultisig.js` and `server.js`. The `erc4337.js` and `safe4337.js` compiled outputs were missing. When Railway ran `node dist/server.js`, Node.js threw `Cannot find module './erc4337'` immediately on startup, causing the process to exit before it could listen on port 3008. This explains why all solver-network requests returned 503 ECONNREFUSED even after gateway waited 120 s.

A secondary issue: `import initSqlJs from 'sql.js'` was present in `server.ts` but `initSqlJs` was never called. This dead import caused `tsc` to fail with a type error, preventing `dist/` from being regenerated locally.

**Fixes:**
- Removed unused `import initSqlJs from 'sql.js'` from `server.ts`
- Re-ran `npx tsc` — compilation now succeeds cleanly
- Committed all 4 compiled files: `erc4337.js`, `safe4337.js`, `safeMultisig.js`, `server.js`

### Files Changed

| File | Change |
|------|--------|
| `packages/solver-network/src/server.ts` | Remove unused `import initSqlJs from 'sql.js'` |
| `packages/solver-network/dist/erc4337.js` | Add missing compiled output |
| `packages/solver-network/dist/safe4337.js` | Add missing compiled output |
| `packages/solver-network/dist/server.js` | Update compiled output (includes all recent fixes) |

---

## [0.0.8] - 2026-03-12

### Fixed — MetaMask "Invalid findTypeDependencies input undefined" When Signing UserOp

**Root cause**: `buildUserOpTypedData()` in `safe4337.ts` returned `{ domain, types, message }` but was missing two fields required by MetaMask's `eth_signTypedData_v4`:
1. `primaryType` — MetaMask calls `findTypeDependencies(primaryType, types)` internally; with `primaryType` undefined this throws immediately
2. `EIP712Domain` in `types` — required by MetaMask v11+ to explicitly list the domain type

**Fix**: Added `primaryType: 'SafeOp'` and `EIP712Domain: [{ chainId, verifyingContract }]` to the return value of `buildUserOpTypedData()`. Also updated `signUserOpWithAI()` to strip `EIP712Domain` before passing types to ethers.js `signTypedData` (which handles domain internally).

### Added — Create Smart Wallet Flow

Users can now deploy a fresh Safe contract on the current Tenderly fork directly from the Explorer UI. This is useful when test wallet addresses don't exist on a given fork.

**Server**: `POST /v1/solver-network/create-smart-wallet`
- `{ ownerAddress, walletType: "multisig" | "safe4337" }`
- `multisig`: deploys 2-of-2 Safe (owners: user + AI key, threshold: 2) → MULTISIG mode
- `safe4337`: deploys Safe with Safe4337Module enabled (owner: user only, threshold: 1) → ERC4337_SAFE mode
- Auto-funds the new Safe with 1 ETH via `tenderly_setBalance`

**safe4337.ts**: Added `deployNewSafeMultisig()` for 2-of-2 Safe deployment (complements existing `deployNewSafe4337Account()`)

**Frontend** (`apps/explorer/index.html`): Added "Create Smart Wallet" panel below the Test Wallets grid. Connects MetaMask, calls the server endpoint, shows the new address with a "Use this wallet" button that auto-fills the search.

### Files Changed

| File | Change |
|------|--------|
| `packages/solver-network/src/safe4337.ts` | `buildUserOpTypedData`: add `primaryType`, `EIP712Domain`; `signUserOpWithAI`: strip `EIP712Domain` before ethers.js call |
| `packages/solver-network/src/safe4337.ts` | Add `deployNewSafeMultisig()` function |
| `packages/solver-network/src/server.ts` | Add `POST /v1/solver-network/create-smart-wallet` endpoint |
| `apps/explorer/index.html` | Create Smart Wallet panel + `createSmartWallet()`, `useCreatedWallet()` functions |
