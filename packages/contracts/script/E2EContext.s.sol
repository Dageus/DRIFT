// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, stdJson } from "forge-std/Script.sol";

import { DRIFTClientFactory } from "../src/client/DRIFTClientFactory.sol";
import { DRIFTCore } from "../src/core/DRIFTCore.sol";
import { WeightedGovernanceClient } from "../src/templates/WeightedGovernance.sol";

/// @title E2EContextScript
/// @notice Sets up one context for the SDK's anvil e2e test (packages/sdk/test/e2e/pipeline.test.ts):
///         registers the context, deploys its WeightedGovernanceClient with the given trusted
///         settler, registers NODE_COUNT nodes (mnemonic indices NODE_OFFSET..), assigns each the
///         MEMBER role and configures the epoch length, dispute and response windows and bonds.
///         The epoch length is set last, so the epoch anchor follows every registration.
/// @dev Env: MNEMONIC, DRIFT_DEPLOYMENT_FILE (read for the core, factory and template; under
///      deployments/), CONTEXT_NAME, SETTLER, CONTEXT_OUT (file name under deployments/ to write
///      {contextUID, client}), NODE_OFFSET, NODE_COUNT, EPOCH_LENGTH, DISPUTE_WINDOW,
///      RESPONSE_WINDOW. Not for production use.
contract E2EContextScript is Script {
    using stdJson for string;

    function run() external {
        string memory mnemonic = vm.envString("MNEMONIC");
        uint256 adminKey = vm.deriveKey(mnemonic, 0);
        address admin = vm.addr(adminKey);
        string memory dir = string.concat(vm.projectRoot(), "/deployments/");
        string memory deployment =
            vm.readFile(string.concat(dir, vm.envString("DRIFT_DEPLOYMENT_FILE")));

        DRIFTCore core = DRIFTCore(deployment.readAddress(".DRIFTCore"));
        DRIFTClientFactory factory = DRIFTClientFactory(deployment.readAddress(".Factory"));
        address template = deployment.readAddress(".WeightedGovernanceTemplate");
        bytes32 role = keccak256("MEMBER");

        vm.startBroadcast(adminKey);
        bytes32 contextUID = core.registerContext(vm.envString("CONTEXT_NAME"));
        bytes32 adminRole = core.contextAdminRole(contextUID);
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = role;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;
        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            deployment.readAddress(".DRIFTToken"),
            contextUID,
            vm.envAddress("SETTLER"),
            0,
            0,
            "EigenTrust",
            roles,
            weights
        );
        WeightedGovernanceClient client = WeightedGovernanceClient(
            factory.deployClient(contextUID, template, initData, contextUID)
        );
        core.grantRole(adminRole, address(client));
        vm.stopBroadcast();

        uint256 offset = vm.envUint("NODE_OFFSET");
        uint256 count = vm.envUint("NODE_COUNT");
        for (uint256 i = 0; i < count; i++) {
            vm.broadcast(vm.deriveKey(mnemonic, uint32(offset + i)));
            core.registerNode(contextUID, "");
        }

        vm.startBroadcast(adminKey);
        for (uint256 i = 0; i < count; i++) {
            client.assignRole(vm.addr(vm.deriveKey(mnemonic, uint32(offset + i))), role);
        }
        client.setDisputeWindow(vm.envUint("DISPUTE_WINDOW"));
        client.setResponseWindow(vm.envUint("RESPONSE_WINDOW"));
        client.setSettlementBond(client.MIN_SETTLEMENT_BOND());
        client.setChallengeBond(client.MIN_CHALLENGE_BOND());
        client.setEpochLength(vm.envUint("EPOCH_LENGTH"));
        vm.stopBroadcast();

        string memory out = vm.serializeBytes32("ctx", "contextUID", contextUID);
        out = vm.serializeAddress("ctx", "client", address(client));
        out = vm.serializeAddress("ctx", "admin", admin);
        vm.writeJson(out, string.concat(dir, vm.envString("CONTEXT_OUT")));
    }
}
