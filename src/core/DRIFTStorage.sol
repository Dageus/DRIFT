// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTTypes } from "../Common.sol";

/// @title  DriftCoreStorage
/// @notice Isolated storage layout for DRIFTCore.
///         Inherited by DRIFTCore to make upgrade storage safety explicit.
abstract contract DRIFTCoreStorage {
    // Context UID => Context
    mapping(bytes32 => Context) public contexts;

    // WARNING: this might be a massive gas cost for no reason
    // Context UID => used
    mapping(bytes32 => bool) internal _usedNames;

    // Context UID => schema UID => accepted
    mapping(bytes32 => mapping(bytes32 => bool)) internal _acceptedSchemas;

    // Context UID => schema UID => adapter address
    mapping(bytes32 => mapping(bytes32 => address)) internal _schemaAdapters;

    // Context UID => agent/node => stake
    mapping(bytes32 => mapping(address => uint256)) internal _stakes;

    // Context UID => Node => Unlock Timestamp
    mapping(bytes32 => mapping(address => uint256)) internal _unlockTimes;

    /// @dev Reserved storage slots for future upgrades.
    ///      Each variable added above must reduce this by its slot count.
    uint256[45] private __gap;
}
