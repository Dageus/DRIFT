// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTCore } from "../../src/core/IDRIFTCore.sol";

/// @title NaiveBatchSettler
/// @notice Test-only reconstruction of the naive per-node on-chain settlement design DRIFT
///         explicitly rejected in favor of Merkle-based lazy settlement (see CLAUDE.md's
///         "Useful background" section: naive batch settlement is O(N) and exceeds the block gas
///         limit at roughly 404 nodes). No such path exists in the shipped protocol — this exists
///         solely to reproduce/extend the comparison dataset for the dissertation's Evaluation
///         chapter (Phase 3 item 4). It registers as a context's client and mints a reward
///         directly per node in a loop instead of settling a single Merkle root.
contract NaiveBatchSettler {
    IDRIFTCore public immutable core;

    constructor(
        address _core
    ) {
        core = IDRIFTCore(_core);
    }

    /// @notice Mints `scores[i]` reputation for `nodes[i]` under `role`, one on-chain call per
    ///         node — the O(N) alternative to a single O(1) `postEpochRoot` + O(log N) claims.
    function settleBatch(
        bytes32 contextUID,
        bytes32 role,
        address[] calldata nodes,
        uint256[] calldata scores
    ) external {
        uint256 len = nodes.length;
        for (uint256 i = 0; i < len; i++) {
            core.reward(contextUID, role, nodes[i], scores[i]);
        }
    }
}
