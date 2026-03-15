/**
 * Token Registry
 *
 * Maps human-readable token symbols and aliases to on-chain addresses.
 * Supports multi-chain (Base, Ethereum mainnet).
 */

export interface TokenInfo {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  chainId: number;
  aliases: string[];
}

// ─── Base (chainId: 8453) ─────────────────────────────────────────────────────
const BASE_TOKENS: TokenInfo[] = [
  {
    symbol: 'ETH',
    name: 'Ether',
    address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    decimals: 18,
    chainId: 8453,
    aliases: ['eth', 'ether', '以太', '以太坊', '以太币'],
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0x4200000000000000000000000000000000000006',
    decimals: 18,
    chainId: 8453,
    aliases: ['weth', 'wrapped eth', 'wrapped ether'],
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    chainId: 8453,
    aliases: ['usdc', 'usd coin', '美元稳定币', 'u', 'usdc.e'],
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    decimals: 6,
    chainId: 8453,
    aliases: ['usdt', 'tether', '泰达币', '泰达'],
  },
  {
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    decimals: 18,
    chainId: 8453,
    aliases: ['dai', 'dai stablecoin'],
  },
  {
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    decimals: 8,
    chainId: 8453,
    aliases: ['cbbtc', 'coinbase btc', 'wrapped btc', 'wbtc', 'btc', '比特币'],
  },
  {
    symbol: 'AERO',
    name: 'Aerodrome Finance',
    address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    decimals: 18,
    chainId: 8453,
    aliases: ['aero', 'aerodrome'],
  },
];

// ─── Ethereum Mainnet (chainId: 1) ────────────────────────────────────────────
const MAINNET_TOKENS: TokenInfo[] = [
  {
    symbol: 'ETH',
    name: 'Ether',
    address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    decimals: 18,
    chainId: 1,
    aliases: ['eth', 'ether', '以太', '以太坊', '以太币'],
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    decimals: 18,
    chainId: 1,
    aliases: ['weth', 'wrapped eth'],
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    chainId: 1,
    aliases: ['usdc', 'usd coin', '美元稳定币', 'u'],
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    chainId: 1,
    aliases: ['usdt', 'tether', '泰达币'],
  },
  {
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    decimals: 18,
    chainId: 1,
    aliases: ['dai'],
  },
  {
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    decimals: 8,
    chainId: 1,
    aliases: ['wbtc', 'wrapped btc', 'btc', '比特币'],
  },
  {
    symbol: 'stETH',
    name: 'Lido Staked ETH',
    address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
    decimals: 18,
    chainId: 1,
    aliases: ['steth', 'lido steth', 'staked eth', 'lido eth'],
  },
  {
    symbol: 'wstETH',
    name: 'Wrapped stETH',
    address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    decimals: 18,
    chainId: 1,
    aliases: ['wsteth', 'wrapped steth', 'wrapped staked eth'],
  },
  {
    symbol: 'fxUSD',
    name: 'f(x) Protocol USD',
    address: '0x085780639CC2cACd35E474e71f4d000e2405d8f6',
    decimals: 18,
    chainId: 1,
    aliases: ['fxusd', 'fx usd', 'fx stable', 'fxprotocol usd'],
  },
];

// ─── Tenderly Virtual Testnet — Ethereum Mainnet Fork (chainId: 99917) ──────────
// This fork mirrors Ethereum mainnet state, so all mainnet contract addresses apply.
const TENDERLY_TOKENS: TokenInfo[] = [
  {
    symbol: 'ETH',
    name: 'Ether',
    address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    decimals: 18,
    chainId: 99917,
    aliases: ['eth', 'ether', '以太', '以太坊', '以太币'],
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',  // Ethereum mainnet WETH
    decimals: 18,
    chainId: 99917,
    aliases: ['weth', 'wrapped eth', 'wrapped ether'],
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',  // Ethereum mainnet USDC
    decimals: 6,
    chainId: 99917,
    aliases: ['usdc', 'usd coin', '美元稳定币', 'u', 'usdc.e'],
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',  // Ethereum mainnet USDT
    decimals: 6,
    chainId: 99917,
    aliases: ['usdt', 'tether', '泰达币', '泰达'],
  },
  {
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',  // Ethereum mainnet DAI
    decimals: 18,
    chainId: 99917,
    aliases: ['dai', 'dai stablecoin'],
  },
  {
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',  // Ethereum mainnet WBTC
    decimals: 8,
    chainId: 99917,
    aliases: ['wbtc', 'wrapped btc', 'btc', '比特币'],
  },
  {
    symbol: 'stETH',
    name: 'Lido Staked ETH',
    address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',  // Ethereum mainnet stETH
    decimals: 18,
    chainId: 99917,
    aliases: ['steth', 'lido steth', 'staked eth', 'lido eth'],
  },
  {
    symbol: 'wstETH',
    name: 'Wrapped stETH',
    address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',  // Ethereum mainnet wstETH
    decimals: 18,
    chainId: 99917,
    aliases: ['wsteth', 'wrapped steth', 'wrapped staked eth'],
  },
  {
    symbol: 'fxUSD',
    name: 'f(x) Protocol USD',
    address: '0x085780639CC2cACd35E474e71f4d000e2405d8f6',
    decimals: 18,
    chainId: 99917,
    aliases: ['fxusd', 'fx usd', 'fx stable', 'fxprotocol usd'],
  },
];

const ALL_TOKENS = [...BASE_TOKENS, ...MAINNET_TOKENS, ...TENDERLY_TOKENS];

/**
 * Resolve a token symbol/alias to its TokenInfo for a given chain.
 */
export function resolveToken(symbolOrAlias: string, chainId: number): TokenInfo | null {
  const normalized = symbolOrAlias.trim().toLowerCase();

  // Direct address match
  if (normalized.startsWith('0x') && normalized.length === 42) {
    return (
      ALL_TOKENS.find(
        (t) => t.address.toLowerCase() === normalized && t.chainId === chainId
      ) ?? {
        symbol: normalized.slice(0, 8).toUpperCase(),
        name: 'Unknown Token',
        address: symbolOrAlias,
        decimals: 18,
        chainId,
        aliases: [],
      }
    );
  }

  // Symbol or alias match
  return (
    ALL_TOKENS.find(
      (t) =>
        t.chainId === chainId &&
        (t.symbol.toLowerCase() === normalized ||
          t.aliases.includes(normalized))
    ) ?? null
  );
}

/**
 * Format a human-readable amount to on-chain units (BigInt string).
 */
export function parseAmount(amount: string | number, decimals: number): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num) || num <= 0) throw new Error(`Invalid amount: ${amount}`);
  const scaled = BigInt(Math.round(num * 10 ** decimals));
  return scaled.toString();
}

/**
 * Format on-chain units back to human-readable string.
 */
export function formatAmount(rawAmount: string, decimals: number): string {
  const num = Number(BigInt(rawAmount)) / 10 ** decimals;
  return num.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/**
 * Get default chain name.
 */
export function getChainName(chainId: number): string {
  const names: Record<number, string> = {
    1: 'Ethereum',
    8453: 'Base',
    84532: 'Base Sepolia',
    31337: 'Localhost',
    99917: 'Tenderly Mainnet Fork',
  };
  return names[chainId] ?? `Chain ${chainId}`;
}

export { BASE_TOKENS, MAINNET_TOKENS };
