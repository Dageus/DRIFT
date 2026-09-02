// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IBrightID } from "../../src/policies/BrightIDPolicy.sol";

contract MockBrightID is IBrightID {
    mapping(address => bool) public verified;

    function setVerified(
        address addr,
        bool status
    ) external {
        verified[addr] = status;
    }

    function isVerified(
        address addr
    ) external view returns (bool) {
        return verified[addr];
    }
}
