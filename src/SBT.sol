// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title DRIFT Identity SBT
 * @notice Soulbound token representing a node's identity and reputation
 *         within the DRIFT ecosystem.
 * @dev    Address-keyed reputation state; token ID is a secondary handle.
 *         Tokens are non-transferable. Banned nodes have their token burned.
 */
contract DRIFT_Identity is ERC721, AccessControl {
    // Roles =========================================================

    /// @notice Granted to the DRIFT engine contract that drives reputation updates.
    bytes32 public constant ENGINE_ROLE = keccak256("ENGINE_ROLE");

    // Storage =======================================================

    // Token ID
    uint256 private _nextTokenId = 1;

    struct Identity {
        uint256 joinTimestamp;
        uint256 initialStake;
        uint256 perfScore;
        bool isBanned;
    }

    /// @notice Primary reputation state, keyed by Token ID.
    mapping(uint256 => Identity) public identities;

    /// @dev Maps token ID ↔ owner address for bidirectional lookups.
    mapping(address => uint256) public tokenOf;

    // Constants =====================================================

    /// @notice Fixed-point scale: 10_000 → 1.0
    uint256 public constant SCORE_SCALE = 10_000;

    /// @notice Starting score for all new nodes (0.5 in fixed-point).
    uint256 public constant INITIAL_SCORE = 5_000;

    // Events =======================================================

    event IdentityMinted(
        address indexed node,
        uint256 indexed tokenId,
        uint256 stake,
        uint256 timestamp
    );
    event ReputationUpdated(
        address indexed node,
        uint256 indexed tokenId,
        uint256 newScore
    );
    event NodeBanned(address indexed node, uint256 indexed tokenId);

    constructor() ERC721("DRIFT-ID", "D-ID") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // Minting ======================================================

    /**
     * @notice Mint a DRIFT identity SBT for a new node.
     * @param  to            The node's wallet address.
     * @param  initialStake  The amount the node staked to join (informational).
     */
    function mint(
        address to,
        uint256 initialStake
    ) external onlyRole(ENGINE_ROLE) {
        require(to != address(0), "DRIFT: Cannot mint to zero address");
        require(balanceOf(to) == 0, "DRIFT: Address already has an identity");

        uint256 tokenId = _nextTokenId++;

        uint timestamp = block.timestamp;

        identities[tokenId] = Identity({
            joinTimestamp: block.timestamp,
            initialStake: initialStake,
            perfScore: INITIAL_SCORE,
            isBanned: false
        });

        tokenOf[to] = tokenId;

        _safeMint(to, tokenId);

        // FIXME: how do we introduce the concept of Epoch here?
        emit IdentityMinted(to, tokenId, timestamp, initialStake);
    }

    /**
     * @notice Update the performance score for a node.
     * @param  node     The node's wallet address.
     * @param  newScore New score value, scaled by SCORE_SCALE.
     */
    function updateReputation(
        address node,
        uint256 newScore
    ) external onlyRole(ENGINE_ROLE) {
        uint256 tokenId = tokenOf[node];
        Identity storage id = identities[tokenId];
        require(!id.isBanned, "DRIFT: Cannot update a banned node");
        // WARNING: how do we prevent this?
        require(newScore <= SCORE_SCALE, "DRIFT: Score exceeds maximum scale");

        id.perfScore = newScore;

        emit ReputationUpdated(node, tokenOf[node], newScore);
    }

    /**
     * @notice Ban a node: zeroes its score, marks it banned, and burns its SBT.
     * @param  node The node's wallet address.
     */
    function banNode(address node) external onlyRole(ENGINE_ROLE) {
        uint256 tokenId = tokenOf[node];
        Identity storage id = identities[tokenId];
        require(!id.isBanned, "DRIFT: Node is already banned");

        id.isBanned = true;
        id.perfScore = 0;

        emit NodeBanned(node, tokenId);

        _burn(tokenId);
    }

    /// @notice Returns the full identity record for a node.
    function getIdentity(address node) external view returns (Identity memory) {
        require(tokenOf[node] != 0, "DRIFT: Address has no identity");
        return identities[tokenOf[node]];
    }

    // Soulbound implementation =====================================

    /**
     * @dev Blocks all transfers except mint (from == 0) and burn (to == 0).
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        require(
            from == address(0) || to == address(0),
            "DRIFT: Soulbound token cannot be transferred"
        );
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
