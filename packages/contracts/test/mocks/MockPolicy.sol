// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IPolicy, NodeStatus } from "../../src/policies/IPolicy.sol";

contract MockPolicy is IPolicy {
    NodeStatus public statusToReturn = NodeStatus.FULL;

    function setStatusToReturn(
        NodeStatus _status
    ) external {
        statusToReturn = _status;
    }

    function evaluate(
        address,
        bytes32,
        bytes calldata
    ) external view returns (NodeStatus) {
        return statusToReturn;
    }
}
