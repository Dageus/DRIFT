// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { EASAdapter } from "../../src/providers/EAS.sol";

contract DeployEASAdapterScript is Script {
    function run() external {
        address easRegistry = vm.envAddress("EAS_REGISTRY");

        vm.startBroadcast();
        EASAdapter adapter = new EASAdapter(easRegistry);
        vm.stopBroadcast();

        console2.log("EASAdapter deployed:", address(adapter));

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");

        string memory jsonValue = string.concat('"', vm.toString(address(adapter)), '"');

        vm.writeJson(jsonValue, path, ".EASAdapter");
    }
}
