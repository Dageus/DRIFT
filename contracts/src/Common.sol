// SPDX-License-Identifier: MIT

pragma solidity 0.8.28;

library DRIFTTypes {
    /// @notice A context is one reputation domain, owned by a client contract.
    struct Context {
        bytes32 uid; // keccak256(name + owner) ?
        string name; // "depin.helium"
        address owner; // who manages this context
        string reputationAlgorithm;
        bool active;
    }
}
