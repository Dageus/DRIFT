// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { DRIFTClientFactory } from "../../src/client/DRIFTClientFactory.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";
import { MockAdapter } from "../mocks/MockAdapter.sol";

contract DRIFTGasBenchmarkTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public template;

    address public admin = makeAddr("admin");
    address public node = makeAddr("node");

    uint256 public settlerPk = 0x1234;
    address public settler = vm.addr(settlerPk);

    bytes32 public contextUID;

    function setUp() public {
        DRIFTCore coreImpl = new DRIFTCore();
        core = DRIFTCore(
            address(new ERC1967Proxy(address(coreImpl), abi.encodeWithSelector(DRIFTCore.initialize.selector, admin)))
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

    function test_Benchmark_RegisterContext() public {
        vm.startPrank(admin);
        vm.startSnapshotGas("RegisterContext");
        core.registerContext("new.context");
        vm.stopSnapshotGas();
        vm.stopPrank();
    }

    function test_Benchmark_AddSchema() public {
        vm.startPrank(admin);
        vm.startSnapshotGas("AddSchema");
        core.addSchema(contextUID, keccak256("schema"), makeAddr("adapter"));
        vm.stopSnapshotGas();
        vm.stopPrank();
    }

    function test_Benchmark_RegisterNode() public {
        vm.startPrank(node);

        vm.startSnapshotGas("RegisterNode");
        core.registerNode(contextUID, "0x");
        vm.stopSnapshotGas();

        vm.stopPrank();
    }

    function test_Benchmark_DeployClientClone() public {
        bytes32[] memory roles = new bytes32[](1);
        uint256[] memory weights = new uint256[](1);
        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            settler,
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

    function test_Benchmark_DeployClientFull() public {
        vm.startSnapshotGas("DeployClientFull");
        new WeightedGovernanceClient();
        vm.stopSnapshotGas();
    }

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

    function test_Benchmark_SettleReputation() public {
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = bytes32("ROLE");
        uint256[] memory weights = new uint256[](1);
        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            settler,
            0,
            "EigenTrust",
            roles,
            weights
        );

        vm.startPrank(admin);
        address cloneAddr = factory.deployClient(contextUID, address(template), initData, bytes32("salt"));
        WeightedGovernanceClient client = WeightedGovernanceClient(cloneAddr);
        core.grantRole(core.contextAdminRole(contextUID), address(client));
        vm.stopPrank();

        vm.prank(node);
        core.registerNode(contextUID, "0x");

        bytes32 structHash = keccak256(abi.encode(client.SETTLE_TYPEHASH(), contextUID, node, roles[0], 100, 0));

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("DRIFT_WeightedGovernance")),
                keccak256(bytes("1")),
                block.chainid,
                address(client)
            )
        );

        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.startSnapshotGas("SettleReputation");
        client.settleReputation(node, roles[0], 100, 0, sig);
        vm.stopSnapshotGas();
    }
}
