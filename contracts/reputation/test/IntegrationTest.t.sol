// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ReputationNFT.sol";

/**
 * @title IntegrationTest
 * @notice End-to-end integration tests simulating the full HIEF reputation lifecycle.
 *
 * These tests simulate the complete flow:
 *   1. Deploy ReputationNFT
 *   2. Off-chain scoring engine computes a snapshot
 *   3. Updater (reputation service) writes score on-chain
 *   4. Solver reads score to adjust quote
 *   5. Policy engine checks meetsScoreThreshold
 *   6. Guardian pauses in emergency
 *   7. Admin recovers
 *
 * Run against a local Anvil fork:
 *   anvil --fork-url $BASE_SEPOLIA_RPC_URL --port 8545
 *   forge test --match-contract IntegrationTest --fork-url http://localhost:8545 -vvv
 *
 * Or run without fork (pure local):
 *   forge test --match-contract IntegrationTest -vvv
 */
contract IntegrationTest is Test {

    ReputationNFT public nft;

    address public admin    = makeAddr("admin");
    address public updater  = makeAddr("updater");
    address public guardian = makeAddr("guardian");
    address public alice    = makeAddr("alice");
    address public bob      = makeAddr("bob");
    address public solver   = makeAddr("solver");

    // ── Setup ─────────────────────────────────────────────────────────────────
    function setUp() public {
        vm.startPrank(admin);
        nft = new ReputationNFT(admin);
        nft.grantRole(nft.UPDATER_ROLE(),  updater);
        nft.grantRole(nft.GUARDIAN_ROLE(), guardian);
        vm.stopPrank();
    }

    // ── Test 1: Full lifecycle for a new user ─────────────────────────────────
    function test_FullLifecycle_NewUser() public {
        // Step 1: New user has no reputation
        assertEq(nft.getScore(alice), 0);
        assertEq(uint8(nft.getRiskTier(alice)), 0); // UNKNOWN

        // Step 2: Off-chain engine computes first snapshot after 3 successful swaps
        // Updater writes it on-chain
        vm.prank(updater);
        nft.updateReputation(
            alice,
            320,   // finalScore (just entered TRUSTED tier)
            300,   // compositeScore
            950,   // successScore  (3/3 success)
            200,   // volumeScore   ($500 total volume)
            100,   // alphaScore
            80,    // diversityScore
            3,     // TRUSTED
            keccak256("alice-snapshot-001")
        );

        // Step 3: Verify on-chain state
        assertEq(nft.getScore(alice), 320);
        assertEq(uint8(nft.getRiskTier(alice)), 3); // TRUSTED
        assertTrue(nft.meetsScoreThreshold(alice, 300));
        assertFalse(nft.meetsScoreThreshold(alice, 500));

        // Step 4: Solver checks reputation before quoting
        // High-reputation users get tighter slippage tolerance
        uint16 score = nft.getScore(alice);
        uint256 maxSlippageBps = _solverSlippagePolicy(score);
        assertEq(maxSlippageBps, 100); // score=320 → STANDARD tier → 100 bps max slippage

        emit log_named_uint("Alice final score", score);
        emit log_named_uint("Max slippage (bps)", maxSlippageBps);
    }

    // ── Test 2: Score progression over multiple updates ───────────────────────
    function test_ScoreProgression() public {
        bytes32[3] memory snapshots = [
            keccak256("bob-snap-001"),
            keccak256("bob-snap-002"),
            keccak256("bob-snap-003")
        ];
        uint16[3] memory scores = [uint16(150), uint16(450), uint16(720)];
        uint8[3]  memory tiers  = [uint8(1),    uint8(2),    uint8(3)];

        for (uint i = 0; i < 3; i++) {
            vm.prank(updater);
            nft.updateReputation(bob, scores[i], scores[i]-10, scores[i]+50, scores[i]-20, scores[i]-30, scores[i]-40, tiers[i], snapshots[i]);

            assertEq(nft.getScore(bob), scores[i]);
            assertEq(uint8(nft.getRiskTier(bob)), tiers[i]);
        }

        // Bob should only have 1 NFT (soulbound, not re-minted)
        assertEq(nft.balanceOf(bob), 1);

        emit log_named_uint("Bob final score after 3 updates", nft.getScore(bob));
    }

    // ── Test 3: Policy engine integration ────────────────────────────────────
    function test_PolicyEngine_ScoreThreshold() public {
        // Seed multiple users with different tiers
        address[4] memory users = [
            makeAddr("unknown_user"),
            makeAddr("low_user"),
            makeAddr("standard_user"),
            makeAddr("elite_user")
        ];
        uint16[4] memory finalScores = [uint16(0), uint16(150), uint16(450), uint16(900)];
        uint8[4]  memory tierValues  = [uint8(0),  uint8(1),    uint8(2),    uint8(4)];

        for (uint i = 1; i < 4; i++) { // skip index 0 (unknown, no NFT)
            vm.prank(updater);
            nft.updateReputation(
                users[i], finalScores[i], finalScores[i], finalScores[i],
                finalScores[i], finalScores[i], finalScores[i],
                tierValues[i], keccak256(abi.encode("snap", i))
            );
        }

        // Policy: require score >= 100 for standard DeFi operations
        uint16 STANDARD_THRESHOLD = 100;
        assertFalse(nft.meetsScoreThreshold(users[0], STANDARD_THRESHOLD)); // UNKNOWN
        assertTrue(nft.meetsScoreThreshold(users[1], STANDARD_THRESHOLD));  // LOW
        assertTrue(nft.meetsScoreThreshold(users[2], STANDARD_THRESHOLD));  // STANDARD
        assertTrue(nft.meetsScoreThreshold(users[3], STANDARD_THRESHOLD));  // ELITE

        // Policy: require score >= 600 for high-value operations (>$100k)
        uint16 HIGH_VALUE_THRESHOLD = 600;
        assertFalse(nft.meetsScoreThreshold(users[0], HIGH_VALUE_THRESHOLD));
        assertFalse(nft.meetsScoreThreshold(users[1], HIGH_VALUE_THRESHOLD));
        assertFalse(nft.meetsScoreThreshold(users[2], HIGH_VALUE_THRESHOLD));
        assertTrue(nft.meetsScoreThreshold(users[3], HIGH_VALUE_THRESHOLD));  // ELITE only
    }

    // ── Test 4: Emergency pause flow ─────────────────────────────────────────
    function test_EmergencyPause_And_Recovery() public {
        // Seed Alice first
        vm.prank(updater);
        nft.updateReputation(alice, 500, 480, 600, 400, 300, 200, 2, keccak256("alice-pre-pause"));

        // Guardian detects anomaly → pauses
        vm.prank(guardian);
        nft.pause();
        assertTrue(nft.paused());

        // Reads still work during pause
        assertEq(nft.getScore(alice), 500);

        // Writes are blocked
        vm.expectRevert();
        vm.prank(updater);
        nft.updateReputation(alice, 600, 580, 700, 500, 400, 300, 3, keccak256("alice-during-pause"));

        // Guardian unpauses after investigation
        vm.prank(guardian);
        nft.unpause();
        assertFalse(nft.paused());

        // Writes work again
        vm.prank(updater);
        nft.updateReputation(alice, 520, 500, 620, 420, 320, 220, 2, keccak256("alice-post-pause"));
        assertEq(nft.getScore(alice), 520);
    }

    // ── Test 5: Soulbound transfer prevention ────────────────────────────────
    function test_Soulbound_CannotTransfer() public {
        vm.prank(updater);
        nft.updateReputation(alice, 400, 380, 500, 300, 200, 150, 2, keccak256("alice-soulbound-test"));

        // Get tokenId from contract's mapping
        uint256 tokenId = nft.tokenIdOf(alice);

        // Direct transfer should revert
        vm.expectRevert(ReputationNFT.Soulbound.selector);
        vm.prank(alice);
        nft.transferFrom(alice, bob, tokenId);

        // Safe transfer should also revert
        vm.expectRevert(ReputationNFT.Soulbound.selector);
        vm.prank(alice);
        nft.safeTransferFrom(alice, bob, tokenId);

        // Alice still owns the token
        assertEq(nft.ownerOf(tokenId), alice);
    }

    // ── Test 6: Composability — external contract reads reputation ────────────
    function test_Composability_ExternalContractReads() public {
        vm.prank(updater);
        nft.updateReputation(alice, 750, 720, 850, 650, 550, 450, 3, keccak256("alice-composability"));

        // Simulate a lending protocol reading reputation
        MockLendingProtocol lending = new MockLendingProtocol(address(nft));
        uint256 ltv = lending.getLTV(alice);

        // TRUSTED tier (score 750) should get 80% LTV
        assertEq(ltv, 80);
        emit log_named_uint("Alice LTV from lending protocol", ltv);
    }

    // ── Test 7: Fuzz — any valid score/tier combination ──────────────────────
    function testFuzz_AnyValidScoreAndTier(
        address user,
        uint16 score,
        uint8 tier
    ) public {
        vm.assume(user != address(0));
        vm.assume(score <= 1000);
        vm.assume(tier <= 4);

        vm.prank(updater);
        nft.updateReputation(user, score, score, score, score, score, score, tier, keccak256(abi.encode(user, score)));

        assertEq(nft.getScore(user), score);
        assertEq(uint8(nft.getRiskTier(user)), tier);
        assertEq(nft.balanceOf(user), 1);
    }

    // ── Helper: Solver slippage policy based on reputation ───────────────────
    function _solverSlippagePolicy(uint16 score) internal pure returns (uint256 maxSlippageBps) {
        if (score >= 850) return 30;   // ELITE:    30 bps
        if (score >= 600) return 50;   // TRUSTED:  50 bps
        if (score >= 300) return 100;  // STANDARD: 100 bps
        if (score >= 100) return 200;  // LOW:      200 bps
        return 500;                    // UNKNOWN:  500 bps
    }
}

// ── Mock Lending Protocol ─────────────────────────────────────────────────────
/**
 * @notice Simulates a third-party lending protocol that reads HIEF reputation
 *         to determine Loan-to-Value ratios.
 */
contract MockLendingProtocol {
    IReputationNFT public immutable reputationNFT;

    constructor(address _nft) {
        reputationNFT = IReputationNFT(_nft);
    }

    /// @notice Returns LTV percentage based on HIEF reputation score
    function getLTV(address user) external view returns (uint256) {
        uint16 score = reputationNFT.getScore(user);
        if (score >= 850) return 85; // ELITE
        if (score >= 600) return 80; // TRUSTED
        if (score >= 300) return 70; // STANDARD
        if (score >= 100) return 60; // LOW
        return 50;                   // UNKNOWN
    }
}

/// @notice Minimal interface for composability testing
interface IReputationNFT {
    function getScore(address account) external view returns (uint16);
    function getRiskTier(address account) external view returns (uint8);
    function meetsScoreThreshold(address account, uint16 minScore) external view returns (bool);
}
