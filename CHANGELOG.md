# HIEF Intent Infrastructure — Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

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
