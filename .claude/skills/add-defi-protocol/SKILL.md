---
name: add-defi-protocol
description: Add a new DeFi protocol adapter to HIEF's plugin registry. Use when user wants to integrate a new protocol (Compound, Lido, Curve, etc.) into the solver network.
argument-hint: <ProtocolName> [skills: DEPOSIT,WITHDRAW,STAKE]
allowed-tools: Read, Grep, Edit, Write, Bash
---

# Add DeFi Protocol Adapter

You are integrating a new DeFi protocol into the HIEF solver network.
The plugin architecture is in `packages/solver-network/src/defiSkills.ts`.

## Step 1 — Read the interface

Read the current `defiSkills.ts` to understand the exact interface:

```
packages/solver-network/src/defiSkills.ts
```

Focus on:
- `DefiProtocolAdapter` interface (id, name, description, supportedChains, supportedSkills, supportsToken, quote, buildCalls)
- `QuoteParams` and `DefiSkillQuote` types
- `CallData` type
- How `AaveV3Adapter` implements everything (use as reference)

## Step 2 — Research the protocol

The protocol to add is: **$ARGUMENTS**

Ask the user for (or infer from $ARGUMENTS):
- Protocol contract addresses on Ethereum mainnet (Pool, Gateway, etc.)
- Which skills to support: DEPOSIT / WITHDRAW / STAKE / UNSTAKE
- ABI signatures for the relevant functions
- Which tokens are supported
- Whether approval is needed before the main call

If the user hasn't provided contract addresses, ask before proceeding.

## Step 3 — Implement the adapter

Generate a new class `<Name>Adapter implements DefiProtocolAdapter` following the exact same pattern as `AaveV3Adapter` in the same file.

Requirements:
- `id` must be kebab-case (e.g. `'compound-v3'`)
- `name` must be human-readable (e.g. `'Compound v3'`)
- `supportsToken` must check against a local constant (like `AAVE_ATOKENS`) — no runtime calls
- `quote()` must: fetch live APY/rate if available, build calldata, return `DefiSkillQuote` with correct `adapterId: this.id`
- `buildCalls()` must: return approve call (if `needsApproval`) + main call
- For WITHDRAW: set `receiptTokenIn` to the receipt token that will be burned (used for simulation funding)
- Return `null` from `quote()` if token is unsupported — never throw

## Step 4 — Register the adapter

At the bottom of `defiSkills.ts`, after `defiRegistry.register(new AaveV3Adapter())`, add:

```typescript
defiRegistry.register(new <Name>Adapter());
```

## Step 5 — Type check

Run:
```bash
cd packages/solver-network && npx tsc --noEmit
```

Fix any type errors before proceeding.

## Step 6 — Add to Explorer UI

In `apps/explorer/index.html`, find the Quick Suggestions block and add an appropriate button:
```html
<button onclick="setChatInput('deposit 100 USDC to <Protocol>')" ...>deposit 100 USDC to <Protocol></button>
```

## Step 7 — Summary

Tell the user:
- What contracts you used
- Which skill types are supported
- Which tokens are supported
- How to test: what chat message to type in the Explorer UI
- Any limitations or TODOs (e.g. "WITHDRAW not yet implemented for this protocol")

## Important constraints

- Do NOT modify `server.ts` — the plugin registry handles routing automatically
- Do NOT add protocol-specific logic to `generateQuote` in server.ts
- Keep all protocol logic inside the adapter class
- Follow the exact same code style as `AaveV3Adapter`
- If you're unsure about contract addresses, ASK the user rather than guessing
