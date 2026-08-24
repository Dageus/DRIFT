// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";

/// @title MockReentrantChallenger
/// @notice Acts as a B1 challenger and attempts to re-enter `claimUnansweredChallenge` for the
///         same (epoch, node) the instant it receives its forfeited-bond payout, to verify the
///         checks-effects-interactions ordering in that function: state must already be resolved
///         and zeroed before the transfer, so the reentrant call fails cleanly rather than
///         double-paying.
contract MockReentrantChallenger {
    WeightedGovernanceClient public target;
    uint256 public epoch;
    address public missingNode;
    bool public reentered;
    bool public reentrancySucceeded;

    function setTarget(
        WeightedGovernanceClient _target,
        uint256 _epoch,
        address _missingNode
    ) external {
        target = _target;
        epoch = _epoch;
        missingNode = _missingNode;
    }

    function challenge(
        uint256 bond
    ) external {
        target.challengeOmission{ value: bond }(epoch, missingNode);
    }

    function claimUnanswered() external {
        target.claimUnansweredChallenge(epoch, missingNode);
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            try target.claimUnansweredChallenge(epoch, missingNode) {
                reentrancySucceeded = true;
            } catch { }
        }
    }
}
