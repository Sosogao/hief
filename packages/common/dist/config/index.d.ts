export declare const HIEF_VERSION = "0.1";
export declare const POLICY_VERSION = "v0.1";
export declare const QUOTE_WINDOW_MS = 30000;
export declare const CHAIN_IDS: {
    readonly MAINNET: 1;
    readonly BASE: 8453;
    readonly BASE_SEPOLIA: 84532;
    readonly HARDHAT: 31337;
};
export declare const CONTRACTS: {
    readonly MULTISEND: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526";
    readonly SAFE_TX_SERVICE_BASE: "https://safe-transaction-base.safe.global";
    readonly COW_SETTLEMENT_BASE: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
    readonly UNISWAPX_REACTOR_BASE: "0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4";
};
export declare const POLICY: {
    readonly MAX_FEE_BPS: 500;
    readonly MAX_SLIPPAGE_BPS: 1000;
    readonly MIN_DEADLINE_BUFFER_SEC: 60;
};
export declare const BLACKLISTED_SELECTORS: Set<string>;
export declare const WHITELISTED_PROTOCOLS: Set<string>;
//# sourceMappingURL=index.d.ts.map