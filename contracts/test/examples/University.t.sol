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
import { MockEAS } from "../mocks/MockEAS.sol";

contract UniversityScenarioTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public client;
    MockAdapter public mockAdapter;

    address public president;
    uint256 public presidentKey;

    address public aliceStudent = makeAddr("aliceStudent");
    address public bobProfessor = makeAddr("bobProfessor");

    // Context & Roles
    bytes32 constant CONTEXT_NAME_HASH = keccak256("Harvard.v1");
    bytes32 constant ROLE_STUDENT = keccak256("STUDENT");
    bytes32 constant ROLE_PROFESSOR = keccak256("PROFESSOR");
    bytes32 constant ROLE_HOD = keccak256("HOD");
    bytes32 public contextUID;

    // Setup ===================================================================

    function setUp() public {
        presidentKey = uint256(keccak256("president.key"));
        president = vm.addr(presidentKey);

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
        core.grantRole(core.CLIENT_ROLE(), address(factory));
        core.grantRole(core.CLIENT_ROLE(), president);
        contextUID = core.registerContext("Harvard.v1");
        vm.stopPrank();

        bytes32[] memory roles = new bytes32[](3);
        roles[0] = ROLE_STUDENT;
        roles[1] = ROLE_PROFESSOR;
        roles[2] = ROLE_HOD;

        uint256[] memory weights = new uint256[](3);
        weights[0] = 1; // Student
        weights[1] = 50; // Professor
        weights[2] = 500; // Head of Dept

        bytes32 salt = bytes32("harvard_dao_v1");

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            president,
            roles,
            weights
        );

        vm.prank(president);
        address cloneAddr = factory.deployClient(contextUID, address(template), initData, salt);
        client = WeightedGovernanceClient(cloneAddr);

        bytes32 adminRole = core.contextAdminRole(contextUID);

        vm.prank(president);
        core.grantRole(adminRole, address(client));
    }

    // Scenario Execution ======================================================

    function test_UniversityEndToEndScenario() public {
        vm.prank(aliceStudent);
        core.registerNode(contextUID);

        vm.prank(bobProfessor);
        core.registerNode(contextUID);

        // Give Bob reputation so he can vote on the schema
        uint256 bobReputation = 100;
        uint256 currentEpoch = 1;
        bytes memory sigBob = _signSettle(
            presidentKey,
            contextUID,
            bobProfessor,
            ROLE_PROFESSOR,
            bobReputation,
            currentEpoch
        );

        // Relayer submits Bob's score
        client.settleReputation(bobProfessor, ROLE_PROFESSOR, bobReputation, currentEpoch, sigBob);

        // President creates the proposal to add the grading schema
        bytes32 gradingSchemaUID = keccak256("schema.grading");
        bytes memory addSchemaPayload = abi.encodeWithSelector(
            IDRIFTCore.addSchema.selector,
            contextUID,
            gradingSchemaUID,
            address(mockAdapter)
        );

        vm.prank(president);
        uint256 setupProposalId = client.createProposal("Add Grading Schema", address(core), addSchemaPayload, 1);

        // Bob (with 500x Professor weight) votes for the schema
        vm.prank(bobProfessor);
        client.castVote(setupProposalId, true);

        // Fast forward past the deadline
        vm.warp(block.timestamp + 2 days);
        client.executeProposal(setupProposalId);

        // Verify the DAO successfully executed the core function
        assertEq(core.getAdapter(contextUID, gradingSchemaUID), address(mockAdapter));

        // mocking the SDK
        uint256 aliceReputation = 10;
        currentEpoch = 1;
        bytes memory sig = _signSettle(
            presidentKey,
            contextUID,
            aliceStudent,
            ROLE_STUDENT,
            aliceReputation,
            currentEpoch
        );

        // Relayer submits the score
        client.settleReputation(aliceStudent, ROLE_STUDENT, aliceReputation, currentEpoch, sig);

        // Verify ERC-1155 token minting
        uint256 studentTokenId = uint256(keccak256(abi.encode(contextUID, ROLE_STUDENT)));
        assertEq(driftToken.balanceOf(aliceStudent, studentTokenId), 10);

        // Create a proposal
        bytes memory emptyPayload = ""; // No on-chain execution needed for this mock
        vm.prank(president);
        uint256 labProposalId = client.createProposal("Fund New CS Lab", address(0), emptyPayload, 7);

        // Alice casts her vote
        vm.prank(aliceStudent);
        client.castVote(labProposalId, true);

        // Verify the vote was weighted correctly
        // 10  * 1 = 10 votes
        (, , , uint256 votesFor, , , , ) = client.getProposal(labProposalId);
        assertEq(votesFor, 10);
    }

    function test_CoreVerifiesAttestationCorrectly() public {
        vm.prank(aliceStudent);
        core.registerNode(contextUID);
        vm.prank(bobProfessor);
        core.registerNode(contextUID);

        bytes32 gradingSchema = keccak256("schema.grading");
        vm.prank(president);
        core.addSchema(contextUID, gradingSchema, address(mockAdapter));

        // shouldPass is true by default
        bool isValid = core.verifyAttestation(
            contextUID,
            gradingSchema,
            bytes32("attestation123"),
            aliceStudent,
            bobProfessor
        );
        assertTrue(isValid, "Attestation should be valid");

        // SDK queries a revoked or invalid attestation
        mockAdapter.setShouldPass(false);
        bool isStillValid = core.verifyAttestation(
            contextUID,
            gradingSchema,
            bytes32("attestation123"),
            aliceStudent,
            bobProfessor
        );
        assertFalse(isStillValid, "Attestation should now be invalid");
    }

    // Signature Helper ========================================================

    function _signSettle(
        uint256 privateKey,
        bytes32 _contextUID,
        address _node,
        bytes32 _role,
        uint256 _score,
        uint256 _epoch
    ) internal view returns (bytes memory) {
        bytes32 DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("DRIFT_WeightedGovernance")),
                keccak256(bytes("1")),
                block.chainid,
                address(client)
            )
        );

        bytes32 structHash = keccak256(abi.encode(client.SETTLE_TYPEHASH(), _contextUID, _node, _role, _score, _epoch));

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
