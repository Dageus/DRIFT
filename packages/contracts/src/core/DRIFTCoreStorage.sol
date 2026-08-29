// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTTypes } from "../Common.sol";
import { NodeStatus } from "../policies/IPolicy.sol";
import { IDRIFTToken } from "../token/IDRIFTToken.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title  DRIFTCoreStorage
/// @notice Isolated storage layout for DRIFTCore.
///         Inherited by DRIFTCore to make upgrade storage safety explicit.
abstract contract DRIFTCoreStorage {
    IDRIFTToken public driftToken;

    // Context UID => Context
    mapping(bytes32 => DRIFTTypes.Context) internal _contexts;

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

    // Context UID => Node Address => block.timestamp at which the node was (most recently) registered.
    mapping(bytes32 => mapping(address => uint256)) internal _nodeRegisteredAt;

    // Context UID => Node Address => block.timestamp at which the node was banned (0 if never banned).
    mapping(bytes32 => mapping(address => uint256)) internal _nodeBannedAt;

    mapping(bytes32 => mapping(address => EnumerableSet.Bytes32Set)) internal _nodeRoles;

    /// @dev Reserved storage slots for future upgrades.
    ///      Each variable added above must reduce this by its slot count.
    uint256[40] private __gap;
}
