# HIEF Changelog

All notable changes to the HIEF platform are documented here.

---

## [1.3.0] — 2025-01 — Real MetaMask EIP-712 Multisig Signing

### Changed

**`packages/solver-network/src/server.ts`** (modified)

The multisig branch of the `POST /execute/:intentId` endpoint was substantially reworked. After calling `proposeSafeMultisig()`, the handler now builds a `SafeTxData` object and calls `buildSafeTxTypedData()` to produce the EIP-712 typed data structure. It then signs the `safeTxHash` with the AI's private key using `signMessage()` (producing an `eth_sign`-type signature with v=31/32). The `SafeTxData`, AI signature, AI signer address, `safeTxHash`, and full EIP-712 typed data object are all stored in the `pendingSimulations` map. The `/execute` response now includes `typedData` and `aiSignerAddress` fields for the frontend.

The old `POST /v1/solver-network/multisig-confirm/:intentId` demo endpoint was replaced with `POST /v1/solver-network/multisig-collect-signature/:intentId`. This endpoint accepts `coSignerSignature` (MetaMask EIP-712 signature) and `coSignerAddress` from the request body. It retrieves the stored `safeTxData` and `aiSignature` from `pendingSimulations`, calls `executeWithSignatures()` to pack both signatures (sorted by signer address, ascending) and submit `execTransaction()` to the Safe contract on the Tenderly fork, then notifies the Intent Bus with the resulting transaction hash.

**`apps/explorer/index.html`** (modified)

The `showMultisigPendingCard()` function now stores the proposal data (including `typedData`) in a module-level `multisigProposals` map keyed by intent ID. The card now shows the AI signer's address with a checkmark and a **"🦊 Sign with MetaMask & Execute"** button.

The `confirmMultisigExecution()` demo function was replaced with `requestMetaMaskSignature(intentId)`. This async function: (1) retrieves the stored `typedData`; (2) calls `eth_requestAccounts` to get the connected wallet address; (3) calls `eth_signTypedData_v4` with the EIP-712 typed data to request the user's MetaMask signature; (4) posts the signature to `/multisig-collect-signature/:intentId`; (5) displays the transaction hash on success. MetaMask rejection (error code 4001) is handled gracefully.

---

## [1.2.0] — 2025-01 — Multisig Mode

### Added

**`packages/solver-network/src/safeMultisig.ts`** (new file)

A new module encapsulating all Gnosis Safe interaction logic. `detectAccountMode()` queries the Tenderly fork RPC to determine whether a given address is a deployed Gnosis Safe contract. If it is, the function reads `getThreshold()` and `getOwners()` from the Safe contract and returns an `AccountInfo` object containing the mode (`DIRECT` or `MULTISIG`), threshold, and owner list. `proposeSafeMultisig()` builds a Safe-compatible transaction payload, computes the `safeTxHash` using the EIP-712 domain separator, signs it with the AI's private key, and submits it to the Gnosis Safe Transaction Service API.

**`packages/solver-network/src/server.ts`** (modified)

The `AuctionResult` interface was extended with `executionMode`, `accountInfo`, `safeTxHash`, `signingUrl`, and `multisigProposal` fields. The `pendingSimulations` in-memory store now persists `accountInfo` alongside simulation data. The `runAuction()` function calls `detectAccountMode()` after simulation and branches: in MULTISIG mode, it calls `proposeSafeMultisig()` and stores the proposal; in DIRECT mode, it waits for the user's `/execute` call. Two new Express endpoints were added: `POST /v1/solver-network/execute/:intentId` (which routes to Direct broadcast or Multisig proposal based on stored `accountInfo`) and `POST /v1/solver-network/multisig-confirm/:intentId` (which simulates co-signer approval and executes the transaction on the Tenderly fork).

**`packages/bus/src/api/intents.ts`** (modified)

Two new endpoints were appended to the intents router. `POST /v1/intents/:intentId/multisig-propose` accepts the Safe proposal payload from the Solver Network, stores it in the database, and transitions the intent status to `PROPOSING`. `GET /v1/intents/:intentId/multisig-status` proxies a request to the Safe Transaction Service to retrieve the current confirmation count for a pending Safe transaction.

**`packages/explorer-api/src/routes/intents.ts`** (modified)

Both the list (`GET /v1/explorer/intents`) and detail (`GET /v1/explorer/intents/:id`) responses now include three additional fields sourced from the database: `executionMode` (string, `DIRECT` or `MULTISIG`), `multisigProposal` (object containing `safeTxHash`, `threshold`, `owners`, `signingUrl`, and `confirmedSignatures`), and `pendingSignaturesAt` (ISO timestamp of when the intent entered the PROPOSING state).

**`apps/explorer/index.html`** (modified)

New CSS classes were added for the `PROPOSING` and `PENDING_SIGNATURES` status colors, the `.multisig-card` container (purple theme), `.mode-badge-direct` and `.mode-badge-multisig` inline badges, `.btn-multisig` action button, and `.sig-dot` / `.sig-progress` signature progress indicators.

The `showSimulationCard()` function was updated to accept an `accountInfo` parameter. When `accountInfo.mode === 'MULTISIG'`, the card renders with a purple theme, displays the Safe owner list and threshold, and shows a "🔐 Propose Multisig Transaction" button instead of the green "⚡ Confirm & Execute" button.

The `executeSettlement()` function was updated to accept an `isMultisig` boolean parameter. In multisig mode, it calls the `/execute` endpoint and, upon receiving a `PENDING_SIGNATURES` response, calls the new `showMultisigPendingCard()` function.

`showMultisigPendingCard()` is a new function that renders the co-signature waiting card. It displays the Safe TX Hash, a row of signature progress dots (one filled for the AI proposer, remaining empty for pending co-signers), a link to the Gnosis Safe app for co-signers, and a "✓ Simulate Co-Signer Approval & Execute" button for the testnet demo.

`confirmMultisigExecution()` is a new function that calls `POST /v1/solver-network/multisig-confirm/:intentId` and displays the resulting transaction hash in a purple-themed message bubble.

---

## [1.1.0] — 2025-01 — Pre-Settlement Simulation

### Added

**`packages/solver-network/src/server.ts`** (modified)

A `simulateSettlement()` function was added that calls the Tenderly `tenderly_simulateTransaction` JSON-RPC method with the proposed transaction calldata. The function parses the response to extract `gasUsed`, expected output amount, balance changes from event logs, and price impact in basis points. The result is stored in the `pendingSimulations` map keyed by intent ID.

The `runAuction()` function was updated to call `simulateSettlement()` after the auction winner is selected, before notifying the Intent Bus. The auction result now includes a `simulation` field.

New endpoints were added: `GET /v1/solver-network/simulation/:intentId` returns the pending simulation result for a given intent, and `POST /v1/solver-network/execute/:intentId` triggers the actual on-chain broadcast after the user confirms.

**`packages/bus/src/api/intents.ts`** (modified)

A new `POST /v1/intents/:intentId/simulate` endpoint was added. It accepts the simulation result from the Solver Network, stores it in the database, and transitions the intent status from `SELECTED` to `SIMULATED`.

**`packages/explorer-api/src/routes/intents.ts`** (modified)

The list and detail responses now include a `simulation` field containing the full simulation result object (`success`, `gasUsed`, `expectedOutputAmount`, `expectedOutputToken`, `expectedOutputUSD`, `balanceChanges`, `priceImpactBps`, `gasEstimateUSD`, `simulatedBlock`).

**`apps/explorer/index.html`** (modified)

New CSS classes were added for `.sim-card`, `.sim-row`, `.sim-label`, `.sim-value`, and `.btn-execute`. The `confirmChatIntent()` function was updated to poll the Solver Network for the simulation result after the auction completes, then call `showSimulationCard()`. The `showSimulationCard()` function renders the simulation data card and the "⚡ Confirm & Execute On-Chain" button. The `executeSettlement()` function broadcasts the transaction and displays the resulting TX hash.

---

## [1.0.0] — 2024-12 — Initial Release

### Added

Core platform components: AI Agent service with GPT-4 intent parsing, Intent Bus with SQLite persistence, Solver Network with competitive auction, Reputation API with scoring and tier classification, Explorer API, and the HIEF Explorer frontend. Gateway reverse proxy routing all services under a single Railway deployment.
