// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTClientFactory } from "../../src/client/DRIFTClientFactory.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { MockAdapter } from "../mocks/MockAdapter.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "forge-std/Test.sol";

contract DRIFTCoreGasBenchmarkTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public template;

    address public admin = makeAddr("admin");
    address public node = makeAddr("node");

    bytes32 public contextUID;

    // SETUP ===================================================================

    function setUp() public {
        DRIFTCore coreImpl = new DRIFTCore();
        core = DRIFTCore(
            address(
                new ERC1967Proxy(
                    address(coreImpl), abi.encodeWithSelector(DRIFTCore.initialize.selector, admin)
                )
            )
        );

        driftToken = new DRIFTToken(address(core));
        vm.prank(admin);
        core.setDriftToken(address(driftToken));

        factory = new DRIFTClientFactory(address(core));
        template = new WeightedGovernanceClient();

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), address(factory));
        contextUID = core.registerContext("benchmark.context");
        vm.stopPrank();
    }

    // CORE BENCHMARKS =========================================================

    /// @notice Measures the gas cost of registering a new context namespace
    function test_Benchmark_RegisterContext() public {
        vm.startPrank(admin);
        vm.startSnapshotGas("RegisterContext");
        core.registerContext("new.context");
        vm.stopSnapshotGas();
        vm.stopPrank();
    }

    /// @notice Measures the gas cost of binding a schema to an adapter
    function test_Benchmark_AddSchema() public {
        vm.startPrank(admin);
        vm.startSnapshotGas("AddSchema");
        core.addSchema(contextUID, keccak256("schema"), makeAddr("adapter"));
        vm.stopSnapshotGas();
        vm.stopPrank();
    }

    /// @notice Measures the gas cost for a node to self-register
    function test_Benchmark_RegisterNode() public {
        vm.startPrank(node);
        vm.startSnapshotGas("RegisterNode");
        core.registerNode(contextUID, "0x");
        vm.stopSnapshotGas();
        vm.stopPrank();
    }

    // CLIENT BENCHMARKS =======================================================

    /// @notice Measures the gas cost of deploying a minimal proxy clone via the factory
    function test_Benchmark_DeployClientClone() public {
        bytes32[] memory roles = new bytes32[](1);
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;
        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            makeAddr("benchmarkSettler"),
            0,
            0,
            "EigenTrust",
            roles,
            weights
        );

        vm.startPrank(admin);
        vm.startSnapshotGas("DeployClientClone");
        factory.deployClient(contextUID, address(template), initData, bytes32("salt"));
        vm.stopSnapshotGas();
        vm.stopPrank();
    }

    /// @notice Measures the gas cost of deploying the full underlying client logic contract
    function test_Benchmark_DeployClientFull() public {
        vm.startSnapshotGas("DeployClientFull");
        new WeightedGovernanceClient();
        vm.stopSnapshotGas();
    }

    // ATTESTATION BENCHMARKS ==================================================

    /// @notice Measures the gas cost of verifying an external attestation through the adapter
    function test_Benchmark_VerifyAttestation() public {
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");
        bytes32 schemaUID = keccak256("benchmark.schema");
        MockAdapter adapter = new MockAdapter();

        vm.prank(admin);
        core.addSchema(contextUID, schemaUID, address(adapter));

        vm.prank(subject);
        core.registerNode(contextUID, "0x");

        vm.prank(attester);
        core.registerNode(contextUID, "0x");

        bytes32 attestationUID = keccak256("attestation");

        vm.startSnapshotGas("VerifyAttestation");
        core.verifyAttestation(contextUID, schemaUID, attestationUID, subject, attester);
        vm.stopSnapshotGas();
    }
}
