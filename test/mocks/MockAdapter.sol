// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IAttestationProvider } from "../../src/providers/IAttestationProvider.sol";

contract MockAdapter is IAttestationProvider {
    bool public shouldPass = true;

    function setShouldPass(bool _pass) external {
        shouldPass = _pass;
    }

    function providerName() external pure returns (string memory) {
        return "Mock";
    }

    function isValid(bytes32, bytes32, address) external view returns (bool) {
        return shouldPass;
    }
}
