/**
 * DeFi Skills — Protocol adapters for non-swap intents (DEPOSIT, STAKE, etc.)
 *
 * Architecture: each DeFi action is a "skill" that implements a common interface.
 * The solver network routes DEPOSIT/STAKE/etc. intents to the appropriate skill.
 * Adding a new protocol (Compound, Lido, Curve) = implement DefiSkillQuote + quote fn.
 *
 * Current skills:
 *   - Aave v3 DEPOSIT (supply) — ETH and ERC-20 on Ethereum mainnet / Tenderly fork
 */

import { ethers } from 'ethers';

// ─── Common Interface ─────────────────────────────────────────────────────────

export type DefiSkillType = 'DEPOSIT' | 'WITHDRAW' | 'STAKE' | 'UNSTAKE' | 'PROVIDE_LIQUIDITY';

export interface DefiSkillQuote {
  protocol: string;               // e.g. 'Aave v3', 'Compound v3', 'Lido'
  skill: DefiSkillType;
  tokenIn: string;                // input token address (ERC-20 or ETH alias)
  tokenOut: string;               // output token address (aToken, stToken, LP)
  tokenOutSymbol: string;         // human-readable (e.g. 'aUSDC', 'stETH')
  amountIn: bigint;
  amountOut: bigint;              // expected output (1:1 for Aave deposits)
  apy: number;                    // estimated annual yield % (e.g. 4.2)
  contractTo: string;             // contract to call
  calldata: string;               // encoded function call
  value: bigint;                  // ETH msg.value (0 for ERC-20)
  needsApproval: boolean;
  approveTarget: string;          // spender for ERC-20 approve
  route: string;                  // human-readable description
  priceImpactBps: number;         // always 0 for deposits (1:1 rate)
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const ETH_ALIAS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const WETH_ADDR  = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// ─── Aave v3 (Ethereum Mainnet — same addresses on Tenderly mainnet fork) ─────

const AAVE_V3_POOL         = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const AAVE_WETH_GATEWAY    = '0xD322A49006FC828F9B5B37Ab215F99B4E5caB19C'; // WrappedTokenGatewayV3

// Supported tokens → their Aave v3 aToken addresses
const AAVE_ATOKENS: Record<string, { aToken: string; symbol: string }> = {
  [WETH_ADDR.toLowerCase()]:                              { aToken: '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8', symbol: 'aWETH'  },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':          { aToken: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c', symbol: 'aUSDC'  },
  '0xdac17f958d2ee523a2206206994597c13d831ec7':          { aToken: '0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a', symbol: 'aUSDT'  },
  '0x6b175474e89094c44da98b954eedeac495271d0f':          { aToken: '0x018008bfb33d285247A21d44E50697654f754e63', symbol: 'aDAI'   },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599':          { aToken: '0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8', symbol: 'aWBTC'  },
};

const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
];

const WETH_GATEWAY_ABI = [
  'function depositETH(address pool, address onBehalfOf, uint16 referralCode) payable',
];

/**
 * Quote an Aave v3 deposit.
 * Returns expected aToken output, current APY, and ready-to-execute calldata.
 *
 * For ETH input: routes through WrappedTokenGatewayV3.depositETH (no approval needed)
 * For ERC-20:   approve(AavePool, amount) + supply(asset, amount, onBehalfOf, 0)
 */
export async function quoteAaveDeposit(
  tokenIn: string,
  amountIn: bigint,
  recipient: string,
  rpcUrl: string,
): Promise<DefiSkillQuote | null> {
  try {
    const isEth     = tokenIn.toLowerCase() === ETH_ALIAS.toLowerCase();
    const assetAddr = isEth ? WETH_ADDR : tokenIn;
    const assetKey  = assetAddr.toLowerCase();

    const entry = AAVE_ATOKENS[assetKey];
    if (!entry) {
      console.warn(`[Aave] Token ${assetAddr} not supported on Aave v3`);
      return null;
    }

    // ── Fetch current supply APY from Aave pool ──────────────────────────────
    let apy = 0;
    try {
      const provider  = new ethers.JsonRpcProvider(rpcUrl);
      const pool      = new ethers.Contract(AAVE_V3_POOL, AAVE_POOL_ABI, provider);
      const reserve   = await pool.getReserveData(assetAddr);
      // currentLiquidityRate is in RAY (1e27) — annualised supply rate
      // APY% ≈ rate / 1e25  (= rate/1e27 * 100)
      apy = Number(BigInt(reserve.currentLiquidityRate)) / 1e25;
    } catch {
      // Fork may not have live Aave data — proceed with apy=0
    }

    // ── Build calldata ───────────────────────────────────────────────────────
    let contractTo: string, calldata: string, value: bigint, needsApproval: boolean, approveTarget: string;

    if (isEth) {
      // ETH → aWETH via WrappedTokenGatewayV3
      const iface = new ethers.Interface(WETH_GATEWAY_ABI);
      calldata      = iface.encodeFunctionData('depositETH', [AAVE_V3_POOL, recipient, 0]);
      contractTo    = AAVE_WETH_GATEWAY;
      value         = amountIn;
      needsApproval = false;
      approveTarget = '';
    } else {
      // ERC-20 → aToken via Pool.supply
      const iface = new ethers.Interface(AAVE_POOL_ABI);
      calldata      = iface.encodeFunctionData('supply', [assetAddr, amountIn, recipient, 0]);
      contractTo    = AAVE_V3_POOL;
      value         = 0n;
      needsApproval = true;
      approveTarget = AAVE_V3_POOL;
    }

    return {
      protocol:       'Aave v3',
      skill:          'DEPOSIT',
      tokenIn:        isEth ? ETH_ALIAS : tokenIn,
      tokenOut:       entry.aToken,
      tokenOutSymbol: entry.symbol,
      amountIn,
      amountOut:      amountIn,           // 1:1 — aTokens accumulate yield over time
      apy,
      contractTo,
      calldata,
      value,
      needsApproval,
      approveTarget,
      route:          `Aave v3 Supply → ${entry.symbol} (${apy.toFixed(2)}% APY)`,
      priceImpactBps: 0,
    };
  } catch (e) {
    console.warn('[Aave]', (e as Error).message?.slice(0, 120));
    return null;
  }
}

/** Build approve + supply call array for MultiSend / Safe execution */
export function buildAaveDepositCalls(
  skill: DefiSkillQuote,
): Array<{ to: string; value: bigint; data: string }> {
  const calls: Array<{ to: string; value: bigint; data: string }> = [];
  if (skill.needsApproval) {
    const approveIface = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)']);
    calls.push({
      to:    skill.tokenIn,
      value: 0n,
      data:  approveIface.encodeFunctionData('approve', [skill.approveTarget, skill.amountIn]),
    });
  }
  calls.push({ to: skill.contractTo, value: skill.value, data: skill.calldata });
  return calls;
}
