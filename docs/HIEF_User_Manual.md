# HIEF Platform — User Manual

**Version 1.3** | AI-Powered DeFi Intent Infrastructure with Real MetaMask Multisig Signing

---

## Overview

HIEF (Human-Intent Execution Framework) is an AI-powered DeFi infrastructure platform that translates natural language into on-chain transactions. Users describe what they want to achieve — for example, "swap 100 USDC for ETH at the best price" — and the platform handles the entire execution pipeline: intent parsing, solver auction, pre-settlement simulation, and on-chain execution.

HIEF supports two distinct execution modes that are automatically selected based on the connected account type:

| Mode | Account Type | Description |
|------|-------------|-------------|
| **Direct Mode** | EOA or Safe with threshold = 1 | AI executes the transaction immediately after user confirmation |
| **Multisig Mode** | Gnosis Safe with threshold ≥ 2 | AI proposes the transaction; co-signers must approve before execution |

Both modes require a **pre-settlement simulation** before any real transaction is broadcast, giving users full visibility into expected outcomes before committing.

---

## Core Features

### 1. AI Agent Chat Interface

The AI Agent is the primary entry point for all DeFi operations. Users interact with it through a natural language chat interface accessible via the **AI Agent** tab in the HIEF Explorer.

**Supported Intent Types:**

- Token swaps (e.g., "swap 100 USDC for ETH")
- Liquidity provision (e.g., "add 50 USDC and 0.02 ETH to Uniswap V3")
- Token transfers (e.g., "send 10 USDC to 0xabc...")
- Yield optimization (e.g., "deposit 200 USDC into the highest-yield protocol")

The agent parses the user's message, extracts the intent parameters, and presents a confirmation preview before proceeding.

### 2. Pre-Settlement Simulation

Before any transaction is broadcast to the blockchain, HIEF runs a dry-run simulation using the Tenderly `tenderly_simulateTransaction` RPC method. The simulation result is displayed in a card showing:

| Field | Description |
|-------|-------------|
| Simulation Status | Whether the dry-run succeeded or failed |
| Expected Output | The amount of tokens the user will receive |
| Balance Changes | Net change in each token balance (input and output) |
| Gas Used | Estimated gas consumption and USD cost |
| Price Impact | Slippage expressed in basis points |
| Simulated Block | The block number at which the simulation was run |

No transaction is broadcast until the user explicitly confirms after reviewing this card.

### 3. Solver Auction

After an intent is submitted, HIEF runs a competitive auction among registered solvers. Each solver submits a quote, and the winner is selected based on the best net output for the user. The auction result is displayed in the chat before the simulation card appears.

### 4. Reputation System

Every address that submits intents accumulates a reputation score (0–1000) based on execution history, volume, and success rate. The **Address Lookup** tab allows users to view any address's reputation profile, including their risk tier (UNKNOWN → LOW → STANDARD → TRUSTED → ELITE) and intent history.

---

## Execution Modes

### Direct Mode

Direct Mode is used when the connected account is a standard EOA or a Gnosis Safe with a threshold of 1. In this mode, the user is the sole decision-maker and the transaction is broadcast immediately after confirmation.

**Step-by-step flow:**

1. The user types an intent in the AI Agent chat (e.g., "swap 100 USDC for ETH").
2. The AI agent parses the intent and presents a preview card with the parsed parameters.
3. The user clicks **"Yes, confirm and submit"** to submit the intent to the HIEF network.
4. The solver auction runs automatically (typically 5–15 seconds).
5. A **Pre-Settlement Simulation** card appears, showing expected output, gas cost, and balance changes. The card displays an **⚡ Direct Mode** badge.
6. The user clicks **"⚡ Confirm & Execute On-Chain"**.
7. The transaction is broadcast to the blockchain (Tenderly fork in the current testnet environment).
8. The chat displays the transaction hash with a link to the Tenderly block explorer.
9. The intent status in the Explorer updates to **EXECUTED**.

### Multisig Mode

Multisig Mode is automatically activated when the connected account is a Gnosis Safe with a signature threshold of 2 or more. In this mode, the AI acts as the first signer and proposes the transaction; additional co-signers must approve before execution.

**Step-by-step flow:**

1. The user types an intent using a Gnosis Safe account.
2. The AI agent parses the intent and presents a preview card.
3. The user confirms submission. The system detects the Safe account and retrieves the threshold and owner list.
4. The solver auction runs automatically.
5. A **Multisig Pre-Settlement Simulation** card appears with a **🔐 Multisig Mode (N-of-M)** badge, showing the same simulation data plus the Safe owner list and required signature count.
6. The user clicks **"🔐 Propose Multisig Transaction"**.
7. The AI proposes the Safe transaction to the Gnosis Safe Transaction Service. The intent status updates to **PROPOSING** (Pending Signatures).
8. A **Awaiting Co-Signatures** card appears showing:
   - The Safe TX Hash
   - Signature progress indicator (dots showing signed vs. pending)
   - A link to open the Gnosis Safe app for co-signers to approve
9. A **"🦊 Sign with MetaMask & Execute"** button appears in the pending card.
10. The user clicks the button. MetaMask opens and displays the **EIP-712 structured data** for the Safe transaction (showing the destination address, value, and calldata in a human-readable format).
11. The user reviews and approves the signature in MetaMask. The AI's signature (collected automatically in step 7) and the user's MetaMask signature are combined.
12. The backend calls `Safe.execTransaction()` on-chain with both signatures packed in the correct order (sorted by signer address, ascending).
13. The transaction is broadcast and the intent status updates to **EXECUTED** with the transaction hash.

**Note on Signature Types:** The AI signer uses an `eth_sign`-style signature (v=31/32), while the MetaMask user signs with `eth_signTypedData_v4` (v=27/28). The Gnosis Safe contract recognizes both signature types and verifies them correctly. If the user rejects the MetaMask signature request, the button resets and the user can retry.

---

## Intent Status Reference

The following table describes all possible intent statuses and their meanings:

| Status | Color | Description |
|--------|-------|-------------|
| `BROADCAST` | Blue | Intent has been submitted and is awaiting solver bids |
| `SELECTED` | Purple | A winning solver has been selected |
| `SIMULATED` | Amber | Pre-settlement simulation has been completed |
| `PROPOSING` | Indigo | Multisig transaction has been proposed; awaiting co-signatures |
| `EXECUTED` | Green | Transaction has been successfully executed on-chain |
| `FAILED` | Red | Transaction execution failed |
| `CANCELLED` | Gray | Intent was cancelled by the user |

---

## API Reference

The following API endpoints are available through the HIEF Gateway:

### Intent Bus API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/intents` | Submit a new intent |
| `GET` | `/v1/intents/:id` | Get intent details |
| `POST` | `/v1/intents/:id/simulate` | Store simulation result and update status to SIMULATED |
| `POST` | `/v1/intents/:id/settle` | Update intent status after on-chain execution |
| `POST` | `/v1/intents/:id/multisig-propose` | Store Safe multisig proposal and update status to PROPOSING |
| `GET` | `/v1/intents/:id/multisig-status` | Poll signature count from Safe Transaction Service |

### Solver Network API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/solver-network/trigger` | Trigger solver auction for an intent |
| `GET` | `/v1/solver-network/auctions` | List recent auction results |
| `GET` | `/v1/solver-network/simulation/:intentId` | Get pending simulation result |
| `POST` | `/v1/solver-network/execute/:intentId` | Confirm and execute (Direct) or propose (Multisig) |
| `POST` | `/v1/solver-network/multisig-collect-signature/:intentId` | Receive co-signer EIP-712 signature and execute Safe TX on-chain |

### Explorer API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/explorer/intents` | List intents with filters |
| `GET` | `/v1/explorer/intents/:id` | Get intent detail with solutions and policy result |
| `GET` | `/v1/explorer/reputation/:address` | Get reputation profile for an address |

---

## Architecture Overview

The HIEF platform consists of the following services, all deployed on Railway and accessible via a single gateway:

```
User Browser
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                     HIEF Gateway                            │
│              (Reverse Proxy — gateway.js)                   │
└────┬──────────┬──────────┬──────────┬──────────┬────────────┘
     │          │          │          │          │
     ▼          ▼          ▼          ▼          ▼
  Agent      Intent     Solver    Explorer   Reputation
  Service     Bus       Network     API        API
  (:3003)   (:3006)    (:3004)    (:3007)    (:3005)
     │          │          │
     │          │          ├── detectAccountMode()
     │          │          │     └── Tenderly RPC (getThreshold)
     │          │          │
     │          │          ├── simulateSettlement()
     │          │          │     └── tenderly_simulateTransaction
     │          │          │
     │          │          ├── proposeSafeMultisig()
     │          │          │     └── Safe Transaction Service
     │          │          │
     │          │          └── settleOnChain()
     │          │                └── Tenderly Fork (broadcast)
     │          │
     │          └── SQLite DB (intents, solutions, proposals)
     │
     └── OpenAI GPT-4 (intent parsing)
```

---

## Change Log

### Version 1.3 (Current)

**Real MetaMask EIP-712 Multisig Signing**

This release replaces the demo co-signer simulation button with a real MetaMask signature flow. When a multisig intent is proposed, the frontend now calls `eth_signTypedData_v4` via `window.ethereum` to request the user's EIP-712 signature for the Safe transaction. The signature is submitted to the new `/multisig-collect-signature` backend endpoint, which combines it with the AI's pre-computed signature and calls `Safe.execTransaction()` directly on the Tenderly fork. The Safe contract verifies both signatures and executes the transaction on-chain.

### Version 1.2

**Multisig Mode Support**

This release introduces full support for Gnosis Safe multisig accounts. The system now automatically detects whether a user's account is a Gnosis Safe and routes the execution through the appropriate flow.

The key changes across the codebase are as follows. In the **Solver Network**, a new `safeMultisig.ts` module was added containing `detectAccountMode()` (which queries the chain to determine if an address is a Safe and reads its threshold and owners) and `proposeSafeMultisig()` (which builds and submits a Safe transaction proposal to the Safe Transaction Service). The `runAuction()` function was updated to call `detectAccountMode()` before simulation, and the `/execute` endpoint now branches into Direct or Multisig paths based on the detected account type. A new `/multisig-collect-signature` endpoint was added to receive the co-signer's EIP-712 signature from MetaMask and call `Safe.execTransaction()` on-chain with both signatures combined.

In the **Intent Bus**, two new endpoints were added: `POST /intents/:id/multisig-propose` stores the Safe proposal data and transitions the intent to `PROPOSING` status, while `GET /intents/:id/multisig-status` polls the Safe Transaction Service for the current signature count.

The **Explorer API** was updated to expose `executionMode`, `multisigProposal`, and `pendingSignaturesAt` fields in both the list and detail responses.

The **Frontend** received the most visible changes. New CSS styles were added for the `PROPOSING` status, multisig cards (purple theme), mode badges, and signature progress indicators. The `showSimulationCard()` function now renders different UI for Direct vs. Multisig modes. A new `showMultisigPendingCard()` function displays the pending signatures card with progress dots and the AI signer's address. The `executeSettlement()` and `requestMetaMaskSignature()` functions handle the respective execution paths.

### Version 1.1

**Pre-Settlement Simulation**

This release added mandatory pre-settlement simulation using the Tenderly `tenderly_simulateTransaction` RPC method. All transactions now go through a dry-run before any real broadcast, giving users full visibility into expected outcomes.

### Version 1.0

**Initial Release**

Core platform launch including AI Agent chat, solver auction, Intent Bus, Reputation API, and Explorer UI.

---

## Frequently Asked Questions

**Q: How does the system know whether to use Direct or Multisig mode?**

A: When an intent is submitted, the Solver Network queries the blockchain to check if the sender address is a Gnosis Safe contract. If it is, it reads the `getThreshold()` value. If the threshold is 2 or greater, Multisig Mode is activated automatically. No manual configuration is required.

**Q: Can I switch between modes manually?**

A: Mode selection is automatic and based on the account type. To use Multisig Mode, use a Gnosis Safe address with threshold ≥ 2 as the sender. To use Direct Mode, use an EOA or a Safe with threshold = 1.

**Q: What happens if the Safe Transaction Service is unreachable?**

A: If the Safe Transaction Service cannot be reached (for example, on a Tenderly virtual testnet), the system falls back to Direct Mode and logs a warning. The simulation result is still shown, and the user can proceed with direct execution.

**Q: Is the simulation always accurate?**

A: The simulation uses the current blockchain state at the time of the auction. Market conditions may change between simulation and execution, which could result in slightly different outcomes. The price impact and slippage tolerance fields in the simulation card help users assess this risk.

**Q: Where can I view my intent history?**

A: The **Intent History** tab in the HIEF Explorer shows all intents submitted from any address. You can also look up a specific address in the **Address Lookup** tab to see its full intent history and reputation score.
