---
name: fx-protocol
description: Integrate f(x) Protocol (fxSAVE) into HIEF as a DefiProtocolAdapter. Use when user mentions "fx protocol", "fxSAVE", "f(x)", "AladdinDAO fx", or asks to deposit USDC to fxSAVE.
argument-hint: [skill: DEPOSIT|WITHDRAW] [token: USDC|fxUSD]
allowed-tools: Read, Grep, Edit, Write, Bash
---

# f(x) Protocol Integration Skill

## Upstream Skill Reference
This integration is based on the upstream FX SDK skill:
https://github.com/AladdinDAO/fx-sdk-skill

Read `SKILL.md` from that repository for:
- Complete SDK API reference
- Token constraints and validation rules
- Error patterns and handling
- fxSAVE config/balance/redeem status queries

## HIEF Adapter Location
The adapter is at: `packages/solver-network/src/adapters/fxProtocol.ts`
Registered via: `packages/solver-network/src/defiSkills.ts` using `skillMarket.register()`

## What this adapter does
- DEPOSIT: deposit USDC into fxSAVE (`sdk.depositFxSave`) → earn yield, receive fxSAVE shares
- WITHDRAW: instant redeem fxSAVE shares to USDC (`sdk.withdrawFxSave`, instant=true)

## Key contracts (Ethereum mainnet)
- USDC: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- fxUSD: `0x085780639CC2cACd35E474e71f4d000e2405d8f6`
- fxSAVE: discovered dynamically from SDK txs (in txs[last].to)

## How to extend
1. Read the upstream SKILL.md from https://github.com/AladdinDAO/fx-sdk-skill
2. Identify the new operation (e.g. increasePosition for ETH market)
3. Add the new DefiSkillType if needed (LEVERAGE_LONG, LEVERAGE_SHORT)
4. Implement in FxProtocolAdapter: supportsToken(), quote(), buildCalls()
5. Run `cd packages/solver-network && npx tsc --noEmit`

## Testing
In the Explorer UI AI chat:
- "deposit 100 USDC to fx" or "deposit 100 USDC to fxSAVE"
- "withdraw 50 USDC from fx" or "withdraw 50 USDC from fxSAVE"
