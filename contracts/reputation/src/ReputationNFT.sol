// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title ReputationNFT
 * @author HIEF Protocol
 * @notice Soulbound ERC-721 NFT representing an address's Intent Reputation Score.
 *
 * @dev Key design decisions:
 *   1. SOULBOUND: Transfers are disabled. Each address can hold at most one token.
 *   2. COMPOSABLE: Other contracts can call `getReputation(address)` to read scores
 *      on-chain without trusting a centralized oracle.
 *   3. UPDATER_ROLE: Only authorized updaters (the off-chain Reputation API) can
 *      write scores. This is a permissioned bridge in Phase 1; Phase 3 will use
 *      TEE-signed proofs to remove this trust assumption.
 *   4. SNAPSHOT_BINDING: Each update records the snapshotId from off-chain computation,
 *      creating an auditable link between on-chain and off-chain state.
 *
 * @custom:security-contact security@hief.xyz
 */
contract ReputationNFT is ERC721, AccessControl {
    using Strings for uint256;

    // ─── Roles ────────────────────────────────────────────────────────────────

    /// @notice Role that can mint tokens and update scores
    bytes32 public constant UPDATER_ROLE = keccak256("UPDATER_ROLE");

    /// @notice Role that can pause the contract in emergencies
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ─── Storage ──────────────────────────────────────────────────────────────

    /// @notice Reputation data stored per token
    struct ReputationData {
        uint16 finalScore;        // 0-1000: final score after decay
        uint16 compositeScore;    // 0-1000: composite before decay
        uint16 successScore;      // 0-1000: S dimension
        uint16 volumeScore;       // 0-1000: V dimension
        uint16 alphaScore;        // 0-1000: A dimension
        uint16 diversityScore;    // 0-1000: D dimension
        uint8  riskTier;          // 0=UNKNOWN,1=LOW,2=STANDARD,3=TRUSTED,4=ELITE
        uint32 updatedAt;         // Unix timestamp (seconds)
        bytes32 snapshotId;       // Off-chain snapshot ID for auditability
    }

    /// @notice Token ID counter (starts at 1)
    uint256 private _nextTokenId = 1;

    /// @notice address → tokenId mapping (0 = no token)
    mapping(address => uint256) public tokenIdOf;

    /// @notice tokenId → ReputationData
    mapping(uint256 => ReputationData) public reputationData;

    /// @notice Whether the contract is paused (emergency circuit breaker)
    bool public paused;

    // ─── Events ───────────────────────────────────────────────────────────────

    event ReputationUpdated(
        address indexed account,
        uint256 indexed tokenId,
        uint16 finalScore,
        uint8 riskTier,
        bytes32 snapshotId
    );

    event Paused(address guardian);
    event Unpaused(address guardian);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error Soulbound();
    error ContractPaused();
    error InvalidScore();
    error InvalidRiskTier();
    error ZeroAddress();

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address admin) ERC721("HIEF Reputation", "HREP") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPDATER_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    // ─── Core: Update Reputation ──────────────────────────────────────────────

    /**
     * @notice Update (or mint) the reputation score for an account.
     * @dev If the account has no token, mints one. Otherwise updates existing data.
     *      Only callable by UPDATER_ROLE.
     *
     * @param account       The address whose reputation is being updated
     * @param finalScore    Final score after time decay (0-1000)
     * @param compositeScore Composite score before decay (0-1000)
     * @param successScore  Success dimension score (0-1000)
     * @param volumeScore   Volume dimension score (0-1000)
     * @param alphaScore    Alpha dimension score (0-1000)
     * @param diversityScore Diversity dimension score (0-1000)
     * @param riskTier      Risk tier (0-4)
     * @param snapshotId    Off-chain snapshot ID for auditability
     */
    function updateReputation(
        address account,
        uint16 finalScore,
        uint16 compositeScore,
        uint16 successScore,
        uint16 volumeScore,
        uint16 alphaScore,
        uint16 diversityScore,
        uint8  riskTier,
        bytes32 snapshotId
    ) external onlyRole(UPDATER_ROLE) {
        if (paused) revert ContractPaused();
        if (account == address(0)) revert ZeroAddress();
        if (finalScore > 1000 || compositeScore > 1000) revert InvalidScore();
        if (riskTier > 4) revert InvalidRiskTier();

        uint256 tokenId = tokenIdOf[account];

        // Mint if no token exists
        if (tokenId == 0) {
            tokenId = _nextTokenId++;
            tokenIdOf[account] = tokenId;
            _safeMint(account, tokenId);
        }

        // Update reputation data
        reputationData[tokenId] = ReputationData({
            finalScore:      finalScore,
            compositeScore:  compositeScore,
            successScore:    successScore,
            volumeScore:     volumeScore,
            alphaScore:      alphaScore,
            diversityScore:  diversityScore,
            riskTier:        riskTier,
            updatedAt:       uint32(block.timestamp),
            snapshotId:      snapshotId
        });

        emit ReputationUpdated(account, tokenId, finalScore, riskTier, snapshotId);
    }

    // ─── Read: Composable Queries ─────────────────────────────────────────────

    /**
     * @notice Get the full reputation data for an account.
     * @dev Returns zero-value struct if account has no token.
     *      This is the primary integration point for other contracts.
     *
     * @param account The address to query
     * @return data The ReputationData struct
     */
    function getReputation(address account) external view returns (ReputationData memory data) {
        uint256 tokenId = tokenIdOf[account];
        if (tokenId == 0) return data; // Returns zero-value struct
        return reputationData[tokenId];
    }

    /**
     * @notice Get just the final score for an account (gas-efficient).
     * @param account The address to query
     * @return score Final reputation score (0-1000), 0 if no token
     */
    function getScore(address account) external view returns (uint16 score) {
        uint256 tokenId = tokenIdOf[account];
        if (tokenId == 0) return 0;
        return reputationData[tokenId].finalScore;
    }

    /**
     * @notice Get the risk tier for an account.
     * @param account The address to query
     * @return tier Risk tier (0=UNKNOWN, 1=LOW, 2=STANDARD, 3=TRUSTED, 4=ELITE)
     */
    function getRiskTier(address account) external view returns (uint8 tier) {
        uint256 tokenId = tokenIdOf[account];
        if (tokenId == 0) return 0; // UNKNOWN
        return reputationData[tokenId].riskTier;
    }

    /**
     * @notice Check if an account meets a minimum score threshold.
     * @dev Useful for on-chain gating (e.g., lending protocols requiring STANDARD+)
     * @param account   The address to check
     * @param minScore  Minimum required score
     * @return meets    True if account score >= minScore
     */
    function meetsScoreThreshold(address account, uint16 minScore) external view returns (bool meets) {
        uint256 tokenId = tokenIdOf[account];
        if (tokenId == 0) return minScore == 0;
        return reputationData[tokenId].finalScore >= minScore;
    }

    /**
     * @notice Check if an account has a token (has any reputation history).
     * @param account The address to check
     */
    function hasReputation(address account) external view returns (bool) {
        return tokenIdOf[account] != 0;
    }

    // ─── Emergency Controls ───────────────────────────────────────────────────

    /**
     * @notice Pause the contract (stops new updates, existing reads still work).
     */
    function pause() external onlyRole(GUARDIAN_ROLE) {
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause the contract.
     */
    function unpause() external onlyRole(GUARDIAN_ROLE) {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─── Soulbound: Disable Transfers ─────────────────────────────────────────

    /**
     * @dev Override to make tokens non-transferable (soulbound).
     *      Minting (from == address(0)) is allowed.
     *      All other transfers are blocked.
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        // Allow minting (from == address(0)) but block all transfers
        if (from != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    // ─── ERC165 ───────────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
