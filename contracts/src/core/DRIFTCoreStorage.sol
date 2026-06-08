// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTTypes } from "../Common.sol";
import { NodeStatus } from "../policies/IPolicy.sol";
import { IDRIFTToken } from "../token/IDRIFTToken.sol";

/// @title  DRIFTCoreStorage
/// @notice Isolated storage layout for DRIFTCore.
///         Inherited by DRIFTCore to make upgrade storage safety explicit.
abstract contract DRIFTCoreStorage {
    IDRIFTToken public driftToken;

    // Context UID => Context
    mapping(bytes32 => DRIFTTypes.Context) internal _contexts;

    // WARNING: this might be a massive gas cost for no reason
    // Context UID => used
    mapping(bytes32 => bool) internal _usedNames;

    // Context UID => schema UID => accepted
    mapping(bytes32 => mapping(bytes32 => bool)) internal _acceptedSchemas;

    // Context UID => schema UID => adapter address
    mapping(bytes32 => mapping(bytes32 => address)) internal _schemaAdapters;

    // Context UID => Node Address => Status
    mapping(bytes32 => mapping(address => NodeStatus)) public nodeStatus;

    // WARNING: contexts are limited to one policy. Should we allow more?
    // Context UID => IPolicy
    mapping(bytes32 => address) public _contextPolicies;

    // Context UID => client address
    mapping(bytes32 => address) internal _contextClients;

    /// @dev Reserved storage slots for future upgrades.
    ///      Each variable added above must reduce this by its slot count.
    uint256[43] private __gap;
}
