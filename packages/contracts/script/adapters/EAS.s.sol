// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { EASAdapter } from "../../src/providers/EAS.sol";

contract DeployEASAdapterScript is Script {
    /// @dev EAS_ADDRESS must be the EAS contract itself (has getAttestation/attest), NOT the
    /// SchemaRegistry (has register/getSchema)
    function run() external {
        address easAddress = vm.envAddress("EAS_ADDRESS");

        vm.startBroadcast();
        EASAdapter adapter = new EASAdapter(easAddress);
        vm.stopBroadcast();

        console2.log("EASAdapter deployed:", address(adapter));

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");

        string memory jsonValue = string.concat('"', vm.toString(address(adapter)), '"');

        vm.writeJson(jsonValue, path, ".EASAdapter");
    }
}
