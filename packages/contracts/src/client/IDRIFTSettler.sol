// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTClient } from "./IDRIFTClient.sol";

/// @title IDRIFTSettler
/// @notice Capability to accept signed reputation scores and forward them to the Core.
interface IDRIFTSettler is IDRIFTClient {
    // EVENTS ==================================================================

    /// @notice Emitted when the trusted settler address is changed
    event SettlerUpdated(address indexed oldSettler, address indexed newSettler);

    /// @notice Emitted when a new epoch root is posted
    event EpochRootPosted(bytes32 indexed contextUID, uint256 indexed epoch, bytes32 merkleRoot);

    /// @notice Emitted when a node successfully claims its reputation for an epoch
    event ReputationClaimed(
        bytes32 indexed contextUID,
        address indexed node,
        bytes32 indexed role,
        uint256 score,
        uint256 epoch
    );

    // ERRORS ==================================================================

    error InvalidSettlerSignature();
    error EpochAlreadyPosted(uint256 epoch);
    error EpochNotFound(uint256 epoch);
    error AlreadyClaimed(address node, bytes32 role, uint256 epoch);
    error InvalidMerkleProof();

    // SETTLEMENT CONFIGURATION ================================================

    /// @notice Rotates the trusted settler key. Must be called by the context admin.
    /// @param newSettler The new address authorized to sign epoch roots
    function setTrustedSettler(address newSettler) external;

    // EPOCH & REPUTATION MANAGEMENT ===========================================

    /// @notice Posts a new epoch root verified by the trusted settler
    /// @param epoch The sequential epoch ID
    /// @param merkleRoot The root of the reputation Merkle tree
    /// @param sig EIP-712 signature from the trusted settler
    function postEpochRoot(uint256 epoch, bytes32 merkleRoot, bytes calldata sig) external;

    /// @notice Claims reputation tokens for a node based on a settled epoch root
    /// @param node Address of the node
    /// @param role Role being claimed
    /// @param score Target reputation score
    /// @param epoch Epoch ID being claimed
    /// @param merkleProof Proof validating the claim against the epoch root
    function claimReputation(
        address node,
        bytes32 role,
        uint256 score,
        uint256 epoch,
        bytes32[] calldata merkleProof
    ) external;

    /// @notice Verifies a reputation proof without making any state changes. Useful for SDK pre-flight checks.
    /// @param node Address of the node
    /// @param role Role being verified
    /// @param score The score being verified
    /// @param epoch The epoch ID to check against
    /// @param merkleProof Proof validating the state
    /// @return True if the proof is valid, false otherwise
    function verifyReputation(
        address node,
        bytes32 role,
        uint256 score,
        uint256 epoch,
        bytes32[] calldata merkleProof
    ) external view returns (bool);
}
