// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Capability: accept signed reputation scores and forward to Core.
interface IDRIFTSettler {
    // Events ==================================================================

    /// @notice
    event SettlerUpdated(address indexed oldSettler, address indexed newSettler);

    /// @notice
    event EpochRootPosted(bytes32 indexed contextUID, uint256 indexed epoch, bytes32 merkleRoot);

    /// @notice
    event ReputationClaimed(
        bytes32 indexed contextUID,
        address indexed node,
        bytes32 indexed role,
        uint256 score,
        uint256 epoch
    );

    // Errors ==================================================================

    /// @notice thrown when a settler's signature doesn't match the expected.
    error InvalidSettlerSignature();
    error EpochAlreadyPosted(uint256 epoch);
    error EpochNotFound(uint256 epoch);
    error AlreadyClaimed(address node, bytes32 role, uint256 epoch);
    error InvalidMerkleProof();

    /// @notice Rotate the trusted settler key. Must be called by the context admin.
    function setTrustedSettler(address newSettler) external;

    function postEpochRoot(uint256 epoch, bytes32 merkleRoot, bytes calldata sig) external;

    function claimReputation(
        address node,
        bytes32 role,
        uint256 score,
        uint256 epoch,
        bytes32[] calldata merkleProof
    ) external;

    /// @notice Verify a reputation proof without state change. For SDK pre-flight checks.
    function verifyReputation(
        address node,
        bytes32 role,
        uint256 score,
        uint256 epoch,
        bytes32[] calldata proof
    ) external view returns (bool);
}
