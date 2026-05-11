// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Capability: accept signed reputation scores and forward to Core.
interface IDRIFTSettler {
    event ReputationSettled(
        bytes32 indexed contextUID,
        address indexed node,
        bytes32 indexed role,
        uint256 score,
        uint256 epoch
    );

    /// @notice Accept a signed reputation score and forward to Core for minting/slashing.
    /// @param node   The node being evaluated.
    /// @param role   The role this score maps to (bytes32(0) for flat contexts).
    /// @param score  Raw score from the off-chain compute layer.
    /// @param epoch  Replay protection — monotonic counter per node+role.
    /// @param sig    EIP-712 signature from the trusted settler.
    function settleReputation(address node, bytes32 role, uint256 score, uint256 epoch, bytes calldata sig) external;
}
