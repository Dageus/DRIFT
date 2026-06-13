// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { ISchemaRegistry } from "@eas/ISchemaRegistry.sol";
import { ISchemaResolver } from "@eas/ISchemaResolver.sol"; // Import required for casting

contract SeedScript is Script {
    function run(address easRegistry) external {
        // Derive key dynamically to maintain a single source of truth
        string memory mnemonic = vm.envString("MNEMONIC");
        uint256 deployerPk = vm.deriveKey(mnemonic, 0);

        vm.startBroadcast(deployerPk);

        ISchemaRegistry registry = ISchemaRegistry(easRegistry);
        ISchemaResolver emptyResolver = ISchemaResolver(address(0));

        // Corrected EAS schema formatting (no parentheses)
        bytes32 peerSchema = registry.register("uint256 score", emptyResolver, true);
        console.log("PeerGradingSchema:", vm.toString(peerSchema));

        bytes32 depinSchema = registry.register(
            "uint256 computationTime, uint256 bandwidth, bool success",
            emptyResolver,
            true
        );
        console.log("DePINSchema:", vm.toString(depinSchema));

        vm.stopBroadcast();
    }
}
