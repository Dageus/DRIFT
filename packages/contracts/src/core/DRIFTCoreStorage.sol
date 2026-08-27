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

    // Context UID => Node Address => block.number at which the node was (most recently) registered.
    // Used by B1 non-inclusion disputes to evaluate eligibility as of a past epoch boundary rather
    // than current status, which a colluding admin could otherwise change after the fact.
    // internal, not public: exposed via the explicit IDRIFTCore.nodeRegisteredAtBlock view function
    // in DRIFTCore.sol, mirroring how `nodeStatus` is exposed via `isRegistered` rather than a raw
    // getter, so it doesn't clash with the interface function of the same name.
    mapping(bytes32 => mapping(address => uint256)) internal _nodeRegisteredAtBlock;

    // Context UID => Node Address => block.number at which the node was banned (0 if never banned).
    mapping(bytes32 => mapping(address => uint256)) internal _nodeBannedAtBlock;

    // Context UID => Node => Role => whether reward() has ever minted this (node, role) pair.
    // Used only to de-duplicate pushes into _nodeEarnedRoles below.
    mapping(bytes32 => mapping(address => mapping(bytes32 => bool))) internal _nodeHasEarnedRole;

    // Context UID => Node => list of roles reward() has ever minted for this node. Enumeration
    // support so deregisterNode can burn every reputation token the node holds in this context —
    // ERC-1155 has no native per-holder token-ID enumeration, so DRIFTCore tracks it itself.
    mapping(bytes32 => mapping(address => bytes32[])) internal _nodeEarnedRoles;

    /// @dev Reserved storage slots for future upgrades.
    ///      Each variable added above must reduce this by its slot count.
    uint256[39] private __gap;
}
