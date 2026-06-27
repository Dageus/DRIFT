// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

enum NodeStatus {
    NONE, // Not registered. Cannot attest or be attested about.
    PROBATION, // Registered but restricted.
    FULL, // Full participant.
    BANNED // Permanently excluded. Cannot re-register.
}

interface IPolicy {
    /// @notice Evaluates if a node can enter a context, and returns their starting status.
    /// @param node The address of the user applying.
    /// @param contextUID The context they want to join.
    /// @param entryProof Arbitrary bytes (could be a signature, EAS UID, ZK proof).
    function evaluate(
        address node,
        bytes32 contextUID,
        bytes calldata entryProof
    ) external returns (NodeStatus);
}
