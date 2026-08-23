// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTClientFactory } from "../../../src/client/DRIFTClientFactory.sol";
import { DRIFTCore } from "../../../src/core/DRIFTCore.sol";
import { IDRIFTCore } from "../../../src/core/IDRIFTCore.sol";
import { WeightedGovernanceClient } from "../../../src/templates/WeightedGovernance.sol";
import { DRIFTToken } from "../../../src/token/DRIFTToken.sol";
import { MockAdapter } from "../../mocks/MockAdapter.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "forge-std/Test.sol";

contract UniversityScenarioTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public client;
    MockAdapter public mockAdapter;

    uint256 public presidentPk = 0x1234;
    address public president = vm.addr(presidentPk);
    address public aliceStudent = makeAddr("aliceStudent");
    address public bobProfessor = makeAddr("bobProfessor");

    bytes32 constant ROLE_STUDENT = keccak256("STUDENT");
    bytes32 constant ROLE_PROFESSOR = keccak256("PROFESSOR");
    bytes32 public contextUID;

    // SETUP ===================================================================

    function setUp() public {
        DRIFTCore coreImpl = new DRIFTCore();
        core = DRIFTCore(
            address(
                new ERC1967Proxy(
                    address(coreImpl),
                    abi.encodeWithSelector(DRIFTCore.initialize.selector, president)
                )
            )
        );

        driftToken = new DRIFTToken(address(core));

        vm.prank(president);
        core.setDriftToken(address(driftToken));

        WeightedGovernanceClient template = new WeightedGovernanceClient();
        factory = new DRIFTClientFactory(address(core));
        mockAdapter = new MockAdapter();

        vm.startPrank(president);
        contextUID = core.registerContext("Harvard.v1");
        core.grantRole(core.FACTORY_ROLE(), address(factory));
        vm.stopPrank();

        bytes32[] memory roles = new bytes32[](2);
        roles[0] = ROLE_STUDENT;
        roles[1] = ROLE_PROFESSOR;

        uint256[] memory weights = new uint256[](2);
        weights[0] = 1000; // STUDENT: 10%
        weights[1] = 9000; // PROFESSOR: 90%

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            president,
            50,
            0,
            "EigenTrust",
            roles,
            weights
        );

        bytes32 adminRole = core.contextAdminRole(contextUID);

        vm.startPrank(president);
        address cloneAddr =
            factory.deployClient(contextUID, address(template), initData, bytes32("salt"));
        client = WeightedGovernanceClient(cloneAddr);
        core.grantRole(adminRole, address(client));
        client.setEpochLength(1);
        vm.stopPrank();
    }

    // SCENARIO ================================================================

    /// @notice Full DAO lifecycle: Context creation, reputation settlement, proposal execution
    function test_UniversityEndToEndScenario() public {
        vm.prank(aliceStudent);
        core.registerNode(contextUID, "0x");

        vm.prank(bobProfessor);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 bobScore = 100;
        uint256 aliceScore = 50;

        bytes32 leafBob = keccak256(
            bytes.concat(
                keccak256(abi.encode(contextUID, bobProfessor, ROLE_PROFESSOR, bobScore, epoch))
            )
        );
        bytes32 leafAlice = keccak256(
            bytes.concat(
                keccak256(abi.encode(contextUID, aliceStudent, ROLE_STUDENT, aliceScore, epoch))
            )
        );

        bytes32 root = leafBob < leafAlice
            ? keccak256(abi.encodePacked(leafBob, leafAlice))
            : keccak256(abi.encodePacked(leafAlice, leafBob));

        vm.roll(block.number + epoch);
        client.postEpochRoot(epoch, root, "", _signRoot(epoch, root));

        bytes32 gradingSchemaUID = keccak256("schema.grading");
        bytes memory addSchemaPayload = abi.encodeWithSelector(
            IDRIFTCore.addSchema.selector, contextUID, gradingSchemaUID, address(mockAdapter)
        );

        bytes32[] memory bobRoles = new bytes32[](1);
        bobRoles[0] = ROLE_PROFESSOR;
        uint256[] memory bobScores = new uint256[](1);
        bobScores[0] = bobScore;
        bytes32[][] memory bobProofs = new bytes32[][](1);
        bobProofs[0] = new bytes32[](1);
        bobProofs[0][0] = leafAlice;

        vm.prank(bobProfessor);
        uint256 setupProposalId = client.createProposalWithProofs(
            "Add Grading Schema", address(core), addSchemaPayload, 1, bobRoles, bobScores, bobProofs
        );

        bytes32[] memory aliceRoles = new bytes32[](1);
        aliceRoles[0] = ROLE_STUDENT;
        uint256[] memory aliceScores = new uint256[](1);
        aliceScores[0] = aliceScore;
        bytes32[][] memory aliceProofs = new bytes32[][](1);
        aliceProofs[0] = new bytes32[](1);
        aliceProofs[0][0] = leafBob;

        vm.prank(aliceStudent);
        client.castVoteWithProofs(setupProposalId, true, aliceRoles, aliceScores, aliceProofs);

        vm.warp(block.timestamp + 2 days);
        client.executeProposal(setupProposalId);

        assertEq(core.getAdapter(contextUID, gradingSchemaUID), address(mockAdapter));
    }

    // INTERNAL HELPERS ========================================================

    function _signRoot(
        uint256 epoch,
        bytes32 root
    ) internal view returns (bytes memory) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("DRIFT_WeightedGovernance")),
                keccak256(bytes("1")),
                block.chainid,
                address(client)
            )
        );

        bytes32 structHash = keccak256(
            abi.encode(client.SETTLE_ROOT_TYPEHASH(), contextUID, epoch, root, keccak256(""))
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(presidentPk, digest);
        return abi.encodePacked(r, s, v);
    }
}
