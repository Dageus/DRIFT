// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IKlerosGTCR } from "../../src/policies/KlerosTCRPolicy.sol";

contract MockKlerosGTCR is IKlerosGTCR {
    mapping(bytes32 => Status) public itemStatus;

    function setStatus(
        bytes32 itemID,
        Status status
    ) external {
        itemStatus[itemID] = status;
    }

    function getItemInfo(
        bytes32 _itemID
    ) external view returns (bytes memory data, Status status, uint256 numberOfRequests) {
        return ("", itemStatus[_itemID], 0);
    }
}
