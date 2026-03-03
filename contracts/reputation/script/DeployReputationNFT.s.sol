// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/ReputationNFT.sol";

/**
 * @title DeployReputationNFT
 * @notice Deployment script for ReputationNFT on Base Sepolia (or any EVM chain).
 *
 * Usage:
 *   # Dry run (no broadcast)
 *   forge script script/DeployReputationNFT.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL \
 *     -vvvv
 *
 *   # Live broadcast
 *   forge script script/DeployReputationNFT.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY \
 *     -vvvv
 *
 * Environment variables required:
 *   DEPLOYER_PRIVATE_KEY   — deployer wallet (pays gas, becomes initial admin)
 *   UPDATER_ADDRESS        — address that will hold UPDATER_ROLE (reputation service)
 *   GUARDIAN_ADDRESS       — address that will hold GUARDIAN_ROLE (multisig / Safe)
 *
 * Optional overrides:
 *   NFT_NAME               — defaults to "HIEF Reputation"
 *   NFT_SYMBOL             — defaults to "HREP"
 */
contract DeployReputationNFT is Script {
    function run() external {
        // ── Load env ────────────────────────────────────────────────────────
        uint256 deployerKey  = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address updater      = vm.envOr("UPDATER_ADDRESS",  address(0));
        address guardian     = vm.envOr("GUARDIAN_ADDRESS", address(0));
        string  memory name  = vm.envOr("NFT_NAME",   string("HIEF Reputation"));
        string  memory symbol= vm.envOr("NFT_SYMBOL", string("HREP"));

        address deployer = vm.addr(deployerKey);

        console.log("=== HIEF ReputationNFT Deployment ===");
        console.log("Deployer  :", deployer);
        console.log("Updater   :", updater  == address(0) ? "deployer (fallback)" : vm.toString(updater));
        console.log("Guardian  :", guardian == address(0) ? "deployer (fallback)" : vm.toString(guardian));
        console.log("NFT Name  :", name);
        console.log("NFT Symbol:", symbol);
        console.log("Chain ID  :", block.chainid);

        // Fallback to deployer if roles not specified
        if (updater  == address(0)) updater  = deployer;
        if (guardian == address(0)) guardian = deployer;

        // ── Deploy ──────────────────────────────────────────────────────────
        vm.startBroadcast(deployerKey);

        ReputationNFT nft = new ReputationNFT(deployer);

        // Grant roles to specified addresses
        if (updater != deployer) {
            nft.grantRole(nft.UPDATER_ROLE(), updater);
        }
        if (guardian != deployer) {
            nft.grantRole(nft.GUARDIAN_ROLE(), guardian);
        }

        vm.stopBroadcast();

        // ── Output ──────────────────────────────────────────────────────────
        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("ReputationNFT address:", address(nft));
        console.log("");
        console.log("Add to .env:");
        console.log(string.concat("REPUTATION_NFT_ADDRESS=", vm.toString(address(nft))));
        console.log("");
        console.log("Verify on Basescan:");
        console.log(string.concat(
            "forge verify-contract ",
            vm.toString(address(nft)),
            " src/ReputationNFT.sol:ReputationNFT",
            " --chain-id ", vm.toString(block.chainid),
            " --etherscan-api-key $BASESCAN_API_KEY",
            ' --constructor-args $(cast abi-encode "constructor(address)" ',
            vm.toString(deployer), ")"
        ));
    }
}
