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

    // ROLE MANAGEMENT BENCHMARKS ==============================================

    bytes32 constant BENCH_ROLE = keccak256("BENCH_ROLE");

    /// @dev Registers a fresh node and sets `admin` as this context's client (onlyContextClient
    ///      gate), self-contained so each benchmark below measures exactly one call in isolation.
    function _freshRoleBenchNode() internal returns (address benchNode) {
        benchNode = makeAddr("roleBenchNode");
        vm.startPrank(admin);
        if (!core.hasRole(core.FACTORY_ROLE(), admin)) {
            core.grantRole(core.FACTORY_ROLE(), admin);
        }
        core.setContextClient(contextUID, admin, admin);
        vm.stopPrank();
        vm.prank(benchNode);
        core.registerNode(contextUID, "0x");
    }

    /// @notice Measures the gas cost of assigning a role to an already-registered node — a fresh
    ///         EnumerableSet.add (2 cold SSTOREs: array push + positions-mapping write).
    function test_Benchmark_AssignRole() public {
        address benchNode = _freshRoleBenchNode();

        vm.prank(admin);
        vm.startSnapshotGas("AssignRole");
        core.assignRole(contextUID, benchNode, BENCH_ROLE);
        vm.stopSnapshotGas();
    }

    /// @notice Measures reward() now that it only reads role membership (one SLOAD via
    ///         EnumerableSet.contains) instead of writing it — the direct efficiency comparison
    ///         point against the pre-explicit-assignment implementation.
    function test_Benchmark_Reward() public {
        address benchNode = _freshRoleBenchNode();
        vm.prank(admin);
        core.assignRole(contextUID, benchNode, BENCH_ROLE);

        vm.prank(admin);
        vm.startSnapshotGas("Reward");
        core.reward(contextUID, BENCH_ROLE, benchNode, 100);
        vm.stopSnapshotGas();
    }

    /// @notice Measures the gas cost of revoking a held role and burning the node's full balance
    ///         for it (EnumerableSet.remove — swap-and-pop, 2 SSTOREs — plus one conditional
    ///         external burn call).
    function test_Benchmark_RevokeRole() public {
        address benchNode = _freshRoleBenchNode();
        vm.startPrank(admin);
        core.assignRole(contextUID, benchNode, BENCH_ROLE);
        core.reward(contextUID, BENCH_ROLE, benchNode, 100);
        vm.stopPrank();

        vm.prank(admin);
        vm.startSnapshotGas("RevokeRole");
        core.revokeRole(contextUID, benchNode, BENCH_ROLE);
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
