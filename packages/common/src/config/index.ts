// HIEF Protocol Constants

export const HIEF_VERSION = '0.1';
export const POLICY_VERSION = 'v0.1';
export const QUOTE_WINDOW_MS = 30_000; // 30 seconds

// Chain IDs
export const CHAIN_IDS = {
  MAINNET: 1,
  BASE: 8453,
  BASE_SEPOLIA: 84532,
  HARDHAT: 31337,
} as const;

// Well-known contract addresses (Base Mainnet)
export const CONTRACTS = {
  MULTISEND: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
  SAFE_TX_SERVICE_BASE: 'https://safe-transaction-base.safe.global',
  COW_SETTLEMENT_BASE: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
  UNISWAPX_REACTOR_BASE: '0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4',
} as const;

// Policy constants
export const POLICY = {
  MAX_FEE_BPS: 500,           // 5% max fee
  MAX_SLIPPAGE_BPS: 1000,     // 10% max slippage
  MIN_DEADLINE_BUFFER_SEC: 60, // At least 60s from now
} as const;

// Known malicious function selectors (4-byte)
export const BLACKLISTED_SELECTORS = new Set([
  '0x13af4035', // setOwner
  '0x7065cb48', // addOwner
  '0xe20056e6', // removeOwner
  '0x694e80c3', // changeThreshold
  '0xf2fde38b', // transferOwnership
  '0x715018a6', // renounceOwnership
]);

// Known safe protocol addresses (whitelist)
export const WHITELISTED_PROTOCOLS = new Set([
  '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', // CoW Settlement
  '0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4', // UniswapX Reactor
  '0x2626664c2603336E57B271c5C0b26F421741e481', // Uniswap V3 Router (Base)
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
]);
