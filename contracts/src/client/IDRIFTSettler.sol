// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Capability: accept signed reputation scores and forward to Core.
interface IDRIFTSettler {
    // Events ==================================================================
    event ReputationSettled(
        bytes32 indexed contextUID,
        address indexed node,
        bytes32 indexed role,
        uint256 score,
        uint256 epoch
    );

    event SettlerUpdated(address indexed oldSettler, address indexed newSettler);

    // Errors ==================================================================

    /// @notice thrown when a settler's signature doesn't match the expected.
    error InvalidSettlerSignature();

    /// @notice Accept a signed reputation score and forward to Core for minting/slashing.
    /// @param node   The node being evaluated.
    /// @param role   The role this score maps to (bytes32(0) for flat contexts).
    /// @param score  Raw score from the off-chain compute layer.
    /// @param epoch  Replay protection — monotonic counter per node+role.
    /// @param sig    EIP-712 signature from the trusted settler.
    function settleReputation(address node, bytes32 role, uint256 score, uint256 epoch, bytes calldata sig) external;

    /// @notice Batch version of settleReputation for gas-efficient bulk updates.
    function settleReputationBatch(
        address[] calldata nodes,
        bytes32[] calldata roles,
        uint256[] calldata scores,
        uint256[] calldata epochs,
        bytes[] calldata sigs
    ) external;

    /// @notice Rotate the trusted settler key. Must be called by the context admin.
    function setTrustedSettler(address newSettler) external;
}
