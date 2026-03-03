// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ReputationNFT.sol";

/**
 * @title ReputationNFT Tests
 * @notice Comprehensive test suite for the ReputationNFT contract.
 *
 * Test categories:
 *   - Deployment & roles
 *   - Minting & score updates
 *   - Soulbound enforcement
 *   - Composable queries
 *   - Access control
 *   - Emergency controls
 *   - Edge cases
 */
contract ReputationNFTTest is Test {
    ReputationNFT public nft;

    address public admin    = makeAddr("admin");
    address public updater  = makeAddr("updater");
    address public guardian = makeAddr("guardian");
    address public alice    = makeAddr("alice");
    address public bob      = makeAddr("bob");
    address public eve      = makeAddr("eve");

    bytes32 public constant UPDATER_ROLE  = keccak256("UPDATER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    bytes32 constant SNAPSHOT_ID_1 = keccak256("snapshot-001");
    bytes32 constant SNAPSHOT_ID_2 = keccak256("snapshot-002");

    // ─── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.startPrank(admin);
        nft = new ReputationNFT(admin);

        // Grant roles to dedicated addresses
        nft.grantRole(UPDATER_ROLE, updater);
        nft.grantRole(GUARDIAN_ROLE, guardian);
        vm.stopPrank();
    }

    // ─── Deployment Tests ─────────────────────────────────────────────────────

    function test_DeploymentSetsCorrectName() public view {
        assertEq(nft.name(), "HIEF Reputation");
        assertEq(nft.symbol(), "HREP");
    }

    function test_AdminHasAllRoles() public view {
        assertTrue(nft.hasRole(nft.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(nft.hasRole(UPDATER_ROLE, admin));
        assertTrue(nft.hasRole(GUARDIAN_ROLE, admin));
    }

    function test_UpdaterHasUpdaterRole() public view {
        assertTrue(nft.hasRole(UPDATER_ROLE, updater));
    }

    function test_RevertOnZeroAddressAdmin() public {
        vm.expectRevert(ReputationNFT.ZeroAddress.selector);
        new ReputationNFT(address(0));
    }

    // ─── Minting & Update Tests ───────────────────────────────────────────────

    function test_FirstUpdateMintsToken() public {
        assertEq(nft.tokenIdOf(alice), 0);
        assertFalse(nft.hasReputation(alice));

        vm.prank(updater);
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);

        assertEq(nft.tokenIdOf(alice), 1);
        assertTrue(nft.hasReputation(alice));
        assertEq(nft.balanceOf(alice), 1);
    }

    function test_UpdateSetsCorrectScores() public {
        vm.prank(updater);
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);

        ReputationNFT.ReputationData memory data = nft.getReputation(alice);
        assertEq(data.finalScore,     750);
        assertEq(data.compositeScore, 800);
        assertEq(data.successScore,   900);
        assertEq(data.volumeScore,    700);
        assertEq(data.alphaScore,     600);
        assertEq(data.diversityScore, 500);
        assertEq(data.riskTier,       3);
        assertEq(data.snapshotId,     SNAPSHOT_ID_1);
        assertEq(data.updatedAt,      uint32(block.timestamp));
    }

    function test_SecondUpdateDoesNotMintNewToken() public {
        vm.startPrank(updater);
        nft.updateReputation(alice, 500, 600, 700, 500, 400, 300, 2, SNAPSHOT_ID_1);
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_2);
        vm.stopPrank();

        // Still only 1 token
        assertEq(nft.balanceOf(alice), 1);
        assertEq(nft.tokenIdOf(alice), 1);

        // Score updated to latest
        assertEq(nft.getScore(alice), 750);
    }

    function test_MultipleAddressesGetDifferentTokenIds() public {
        vm.startPrank(updater);
        nft.updateReputation(alice, 500, 600, 700, 500, 400, 300, 2, SNAPSHOT_ID_1);
        nft.updateReputation(bob,   300, 400, 600, 300, 200, 100, 1, SNAPSHOT_ID_2);
        vm.stopPrank();

        assertEq(nft.tokenIdOf(alice), 1);
        assertEq(nft.tokenIdOf(bob),   2);
    }

    function test_EmitsReputationUpdatedEvent() public {
        vm.expectEmit(true, true, false, true);
        emit ReputationNFT.ReputationUpdated(alice, 1, 750, 3, SNAPSHOT_ID_1);

        vm.prank(updater);
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);
    }

    // ─── Soulbound Tests ──────────────────────────────────────────────────────

    function test_TransferReverts() public {
        vm.prank(updater);
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);

        uint256 tokenId = nft.tokenIdOf(alice);

        vm.prank(alice);
        vm.expectRevert(ReputationNFT.Soulbound.selector);
        nft.transferFrom(alice, bob, tokenId);
    }

    function test_SafeTransferReverts() public {
        vm.prank(updater);
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);

        uint256 tokenId = nft.tokenIdOf(alice);

        vm.prank(alice);
        vm.expectRevert(ReputationNFT.Soulbound.selector);
        nft.safeTransferFrom(alice, bob, tokenId);
    }

    // ─── Composable Query Tests ───────────────────────────────────────────────

    function test_GetReputationReturnsZeroForUnknownAddress() public view {
        ReputationNFT.ReputationData memory data = nft.getReputation(eve);
        assertEq(data.finalScore, 0);
        assertEq(data.riskTier,   0);
    }

    function test_GetScoreReturnsZeroForUnknownAddress() public view {
        assertEq(nft.getScore(eve), 0);
    }

    function test_GetRiskTierReturnsZeroForUnknownAddress() public view {
        assertEq(nft.getRiskTier(eve), 0);
    }

    function test_MeetsScoreThresholdReturnsTrueForZeroMin() public view {
        assertTrue(nft.meetsScoreThreshold(eve, 0));
    }

    function test_MeetsScoreThresholdReturnsFalseForUnknownAboveZero() public view {
        assertFalse(nft.meetsScoreThreshold(eve, 1));
    }

    function test_MeetsScoreThresholdWorksCorrectly() public {
        vm.prank(updater);
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);

        assertTrue(nft.meetsScoreThreshold(alice, 0));
        assertTrue(nft.meetsScoreThreshold(alice, 500));
        assertTrue(nft.meetsScoreThreshold(alice, 750));
        assertFalse(nft.meetsScoreThreshold(alice, 751));
        assertFalse(nft.meetsScoreThreshold(alice, 1000));
    }

    function test_GetRiskTierReturnsCorrectTier() public {
        vm.prank(updater);
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);

        assertEq(nft.getRiskTier(alice), 3); // TRUSTED
    }

    // ─── Access Control Tests ─────────────────────────────────────────────────

    function test_NonUpdaterCannotUpdateReputation() public {
        vm.prank(eve);
        vm.expectRevert();
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);
    }

    function test_RevertOnInvalidScore() public {
        vm.prank(updater);
        vm.expectRevert(ReputationNFT.InvalidScore.selector);
        nft.updateReputation(alice, 1001, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);
    }

    function test_RevertOnInvalidRiskTier() public {
        vm.prank(updater);
        vm.expectRevert(ReputationNFT.InvalidRiskTier.selector);
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 5, SNAPSHOT_ID_1);
    }

    function test_RevertOnZeroAddressUpdate() public {
        vm.prank(updater);
        vm.expectRevert(ReputationNFT.ZeroAddress.selector);
        nft.updateReputation(address(0), 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);
    }

    // ─── Emergency Controls Tests ─────────────────────────────────────────────

    function test_GuardianCanPause() public {
        vm.prank(guardian);
        nft.pause();
        assertTrue(nft.paused());
    }

    function test_GuardianCanUnpause() public {
        vm.startPrank(guardian);
        nft.pause();
        nft.unpause();
        vm.stopPrank();
        assertFalse(nft.paused());
    }

    function test_UpdateRevertsWhenPaused() public {
        vm.prank(guardian);
        nft.pause();

        vm.prank(updater);
        vm.expectRevert(ReputationNFT.ContractPaused.selector);
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);
    }

    function test_ReadsWorkWhenPaused() public {
        // First update some data
        vm.prank(updater);
        nft.updateReputation(alice, 750, 800, 900, 700, 600, 500, 3, SNAPSHOT_ID_1);

        // Pause
        vm.prank(guardian);
        nft.pause();

        // Reads should still work
        assertEq(nft.getScore(alice), 750);
        assertEq(nft.getRiskTier(alice), 3);
        assertTrue(nft.hasReputation(alice));
    }

    function test_NonGuardianCannotPause() public {
        vm.prank(eve);
        vm.expectRevert();
        nft.pause();
    }

    // ─── Fuzz Tests ───────────────────────────────────────────────────────────

    function testFuzz_UpdateAndQueryScore(
        address account,
        uint16 finalScore,
        uint8 riskTier
    ) public {
        vm.assume(account != address(0));
        vm.assume(finalScore <= 1000);
        vm.assume(riskTier <= 4);

        vm.prank(updater);
        nft.updateReputation(account, finalScore, finalScore, finalScore, finalScore, finalScore, finalScore, riskTier, SNAPSHOT_ID_1);

        assertEq(nft.getScore(account), finalScore);
        assertEq(nft.getRiskTier(account), riskTier);
        assertTrue(nft.hasReputation(account));
    }
}
