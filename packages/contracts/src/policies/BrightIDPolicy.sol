// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IPolicy, NodeStatus } from "./IPolicy.sol";

/// @dev BrightID's actual on-chain verification surface, from BrightID/BrightID-SmartContract's
///      IBrightID.sol — verified against source rather than assumed. Note there is no separate
///      "context" parameter here: BrightID's `app` identifier is set once at deployment on the
///      BrightID contract itself (constructor/setApp), so each deployed BrightID instance already
///      corresponds to exactly one app/context — nothing for this policy to pass through.
interface IBrightID {
    function isVerified(
        address addr
    ) external view returns (bool);
}

/// @title BrightIDPolicy
/// @notice Context admission policy gated by BrightID unique-humanity verification.
/// @dev Fully immutable configuration, matching EASPolicy/VouchingPolicy's posture. `entryProof`
///      is unused: BrightID verification state lives entirely on the BrightID contract itself,
///      keyed only by address, so there is nothing for the caller to additionally prove here.
contract BrightIDPolicy is IPolicy {
    error NotBrightIDVerified(address node);

    /// @notice The BrightID verification contract for one specific app/context.
    IBrightID public immutable brightID;

    /// @param _brightID Address of the deployed BrightID contract already bound to the desired
    ///        app — confirm which `app` it was constructed with before pointing a context at it.
    constructor(
        address _brightID
    ) {
        brightID = IBrightID(_brightID);
    }

    /// @inheritdoc IPolicy
    function evaluate(
        address node,
        bytes32,
        /* contextUID */
        bytes calldata /* entryProof */
    ) external view returns (NodeStatus) {
        if (!brightID.isVerified(node)) revert NotBrightIDVerified(node);
        return NodeStatus.FULL;
    }
}
