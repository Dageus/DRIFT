// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTCore } from "../../src/core/IDRIFTCore.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";

/// @title MockHostileRecipient
/// @notice A challenger whose `receive` can refuse payment in the ways a griefer would: a plain
///         revert, burning every unit of forwarded gas, or reverting with a large payload that a
///         caller copying return data would pay to expand memory for. Used to check that no
///         payout to a third party can block challenge resolution or epoch finalization.
contract MockHostileRecipient {
    enum Mode {
        Accept,
        Reject,
        BurnGas,
        ReturnBomb
    }

    Mode public mode;
    WeightedGovernanceClient public immutable target;

    constructor(
        WeightedGovernanceClient _target
    ) {
        target = _target;
    }

    function setMode(
        Mode m
    ) external {
        mode = m;
    }

    function register(
        IDRIFTCore core,
        bytes32 contextUID
    ) external {
        core.registerNode(contextUID, "0x");
    }

    function challenge(
        uint256 epoch,
        address node,
        bytes32 role
    ) external payable {
        target.challengeOmission{ value: msg.value }(epoch, node, role);
    }

    function withdraw() external {
        target.withdrawPendingPayout();
    }

    receive() external payable {
        Mode m = mode;
        if (m == Mode.Accept) return;
        if (m == Mode.Reject) revert();
        if (m == Mode.BurnGas) {
            while (true) { }
        }
        // ~100 KB of revert data: about as much as fits in the payout stipend; copying it costs the caller ~35k gas.
        assembly {
            revert(0, 100000)
        }
    }
}
