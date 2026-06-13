// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { EASAdapter } from "../../src/providers/EAS.sol";

contract DeployEASAdapterScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.deriveKey(vm.envString("MNEMONIC"), 0);
        address easRegistry = vm.envAddress("EAS_REGISTRY");

        vm.startBroadcast(deployerPrivateKey);

        EASAdapter adapter = new EASAdapter(easRegistry);
        console2.log("EASAdapter deployed:", address(adapter));

        vm.stopBroadcast();
    }
}
