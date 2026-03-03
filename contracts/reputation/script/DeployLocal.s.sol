// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/ReputationNFT.sol";

/**
 * @title DeployLocal
 * @notice Quick deployment script for local Anvil / Base fork testing.
 *
 * Uses Anvil's default test account #0 as deployer/updater/guardian.
 *
 * Usage:
 *   # Start Anvil fork of Base Sepolia
 *   anvil --fork-url $BASE_SEPOLIA_RPC_URL --chain-id 84532 --port 8545
 *
 *   # Deploy (in another terminal)
 *   forge script script/DeployLocal.s.sol \
 *     --rpc-url http://localhost:8545 \
 *     --broadcast \
 *     -vvvv
 */
contract DeployLocal is Script {
    // Anvil default account #0
    address constant ANVIL_DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    uint256 constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        vm.startBroadcast(ANVIL_KEY);

        ReputationNFT nft = new ReputationNFT(ANVIL_DEPLOYER);

        console.log("ReputationNFT deployed at:", address(nft));
        console.log("Chain ID:", block.chainid);

        // Seed a test score for the deployer
        nft.updateReputation(
            ANVIL_DEPLOYER,
            750,   // finalScore
            700,   // compositeScore
            900,   // successScore
            600,   // volumeScore
            500,   // alphaScore
            400,   // diversityScore
            3,     // riskTier = TRUSTED
            keccak256("seed-snapshot-001")
        );

        console.log("Seeded test reputation for deployer.");
        console.log("Final score:", nft.getScore(ANVIL_DEPLOYER));

        vm.stopBroadcast();
    }
}
