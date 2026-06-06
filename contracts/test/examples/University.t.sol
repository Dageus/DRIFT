// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { IDRIFTCore } from "../../src/core/IDRIFTCore.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { DRIFTClientFactory } from "../../src/client/DRIFTClientFactory.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";
import { MockAdapter } from "../mocks/MockAdapter.sol";

contract UniversityScenarioTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public client;
    MockAdapter public mockAdapter;

    address public president = makeAddr("president");
    address public aliceStudent = makeAddr("aliceStudent");
    address public bobProfessor = makeAddr("bobProfessor");

    bytes32 constant ROLE_STUDENT = keccak256("STUDENT");
    bytes32 constant ROLE_PROFESSOR = keccak256("PROFESSOR");
    bytes32 public contextUID;

    function setUp() public {
        DRIFTCore coreImpl = new DRIFTCore();
        core = DRIFTCore(
            address(
                new ERC1967Proxy(address(coreImpl), abi.encodeWithSelector(DRIFTCore.initialize.selector, president))
            )
        );
        driftToken = new DRIFTToken(address(core));

        vm.prank(president);
        core.setDriftToken(address(driftToken));

        WeightedGovernanceClient template = new WeightedGovernanceClient();
        factory = new DRIFTClientFactory(address(core));
        mockAdapter = new MockAdapter();

        vm.startPrank(president);
        contextUID = core.registerContext("Harvard.v1", ""); // reputation algorithms aren't important here
        vm.stopPrank();

        bytes32[] memory roles = new bytes32[](2);
        roles[0] = ROLE_STUDENT;
        roles[1] = ROLE_PROFESSOR;

        uint256[] memory weights = new uint256[](2);
        weights[0] = 1;
        weights[1] = 50;

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            president,
            roles,
            weights
        );

        bytes32 adminRole = core.contextAdminRole(contextUID);
        vm.startPrank(president);
        address cloneAddr = factory.deployClient(contextUID, address(template), initData, bytes32("salt"));
        client = WeightedGovernanceClient(cloneAddr);
        core.grantRole(adminRole, address(client));
        vm.stopPrank();
    }

    function test_UniversityEndToEndScenario() public {
        vm.prank(aliceStudent);
        core.registerNode(contextUID, "0x");

        vm.prank(bobProfessor);
        core.registerNode(contextUID, "0x");

        vm.prank(president);
        core.reward(contextUID, ROLE_PROFESSOR, bobProfessor, 100);

        bytes32 gradingSchemaUID = keccak256("schema.grading");
        bytes memory addSchemaPayload = abi.encodeWithSelector(
            IDRIFTCore.addSchema.selector,
            contextUID,
            gradingSchemaUID,
            address(mockAdapter)
        );

        vm.prank(president);
        uint256 setupProposalId = client.createProposal("Add Grading Schema", address(core), addSchemaPayload, 1);

        vm.prank(bobProfessor);
        client.castVote(setupProposalId, true);

        vm.warp(block.timestamp + 2 days);
        client.executeProposal(setupProposalId);

        assertEq(core.getAdapter(contextUID, gradingSchemaUID), address(mockAdapter));
    }
}
