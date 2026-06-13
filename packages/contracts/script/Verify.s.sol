// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2, stdJson } from "forge-std/Script.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { DRIFTCore } from "../src/core/DRIFTCore.sol";
import { DRIFTToken } from "../src/token/DRIFTToken.sol";
import { DRIFTClientFactory } from "../src/client/DRIFTClientFactory.sol";
import { WeightedGovernanceClient } from "../src/templates/WeightedGovernance.sol";

contract VerifyScript is Script {
    function run() external view {
        string memory path = string.concat(
            vm.projectRoot(), "/deployments/",
            vm.toString(block.chainid), ".json"
        );
        string memory json = vm.readFile(path);

        DRIFTCore core = DRIFTCore(vm.parseJsonAddress(json, ".DRIFTCore"));

        // Check FACTORY_ROLE is granted
        address factory = vm.parseJsonAddress(json, ".Factory");
        require(
            core.hasRole(core.FACTORY_ROLE(), factory),
            "Verify: FACTORY_ROLE not granted to factory"
        );

        // Check token is set
        require(
            address(core.driftToken()) != address(0),
            "Verify: DRIFTToken not wired into Core"
        );

        // Check implementation matches
        address impl = vm.parseJsonAddress(json, ".DRIFTCoreImplementation");
        address slot = address(uint160(uint256(
            vm.load(address(core), bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1))
        )));
        require(slot == impl, "Verify: implementation mismatch");

        console2.log("All checks passed.");
    }
}
