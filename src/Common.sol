// SPDX-License-Identifier: MIT

pragma solidity 0.8.28;

library DRIFTTypes {
    /// @notice A context is one reputation domain, owned by a client contract.
    struct Context {
        bytes32 uid; // keccak256(name + owner) ?
        string name; // "depin.helium"
        address owner; // who manages this context
        address stakeToken; // ERC-20 token used for staking, address(0) if none
        uint256 minimumStake; // minimum balance required to be a valid subject
        bool active;
    }

    /// @notice Normalized attestation data returned by any IAttestationProvider.
    ///         Decouples DRIFT from EAS's internal struct layout.
    struct AttestationData {
        bytes32 uid;
        bytes32 schemaUID;
        address subject;
        address attester;
        address provider;
        uint64 timestamp;
        uint64 expirationTime;
        bool revoked;
        bytes data; // ABI-encoded per schema definition
    }
}
