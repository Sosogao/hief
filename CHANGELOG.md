# HIEF Intent Infrastructure — Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
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
