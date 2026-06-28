// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTClientFactory } from "../../../src/client/DRIFTClientFactory.sol";
import { DRIFTCore } from "../../../src/core/DRIFTCore.sol";
import { WeightedGovernanceClient } from "../../../src/templates/WeightedGovernance.sol";
import { DRIFTToken } from "../../../src/token/DRIFTToken.sol";
import { DRIFTTestHelper } from "../../utils/DRIFTTestHelper.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract WeightedGovernanceClientTest is DRIFTTestHelper {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public client;

    address public admin = makeAddr("admin");
    address public node = makeAddr("node");
    bytes32 public contextUID;

    uint256 public settlerPk = 0x1234;
    address public settler = vm.addr(settlerPk);

    bytes32 constant ROLE_STUDENT = keccak256("STUDENT");
    bytes32 constant ROLE_PROFESSOR = keccak256("PROFESSOR");

    // SETUP ===================================================================

    function setUp() public {
        DRIFTCore coreImpl = new DRIFTCore();
        bytes memory coreInit = abi.encodeWithSelector(DRIFTCore.initialize.selector, admin);
        core = DRIFTCore(address(new ERC1967Proxy(address(coreImpl), coreInit)));

        driftToken = new DRIFTToken(address(core));

        vm.prank(admin);
        core.setDriftToken(address(driftToken));

        WeightedGovernanceClient template = new WeightedGovernanceClient();
        factory = new DRIFTClientFactory(address(core));

        vm.startPrank(admin);
        contextUID = core.registerContext("test.university");
        core.grantRole(core.FACTORY_ROLE(), address(factory));
        vm.stopPrank();

        bytes32[] memory roles = new bytes32[](2);
        roles[0] = ROLE_STUDENT;
        roles[1] = ROLE_PROFESSOR;

        uint256[] memory weights = new uint256[](2);
        weights[0] = 1;
        weights[1] = 5;

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            settler,
            100, // Proposal threshold is 100 voting power
            0,
            "EigenTrust",
            roles,
            weights
        );

        bytes32 adminRole = core.contextAdminRole(contextUID);

        vm.startPrank(admin);
        core.grantRole(adminRole, admin);
        address cloneAddr =
            factory.deployClient(contextUID, address(template), initData, bytes32("salt"));
        client = WeightedGovernanceClient(cloneAddr);
        core.grantRole(adminRole, address(client));
        vm.stopPrank();
    }

    // INITIALIZATION ==========================================================

    /// @notice Verifies client constructor and initializers correctly load arrays
    function test_InitializationSetsWeights() public view {
        assertEq(client.roleWeights(ROLE_STUDENT), 1);
        assertEq(client.roleWeights(ROLE_PROFESSOR), 5);
        assertEq(client.trustedSettler(), settler);
    }

    // REPUTATION CLAIMS =======================================================

    /// @notice Validates that a node can submit a root and subsequently claim their tokens
    function test_MerklePostRootAndClaim_SingleNode() public {
        vm.prank(node);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 50;

        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, node, ROLE_PROFESSOR, score, epoch)))
        );
        bytes32 root = leaf;
        bytes memory sig = _signEpochRoot(settlerPk, contextUID, epoch, root, address(client));

        client.postEpochRoot(epoch, root, "", sig);

        bytes32[] memory proof = new bytes32[](0);

        vm.prank(node);
        client.claimReputation(node, ROLE_PROFESSOR, score, epoch, proof);

        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, ROLE_PROFESSOR)));
        assertEq(driftToken.balanceOf(node, tokenId), score);
    }

    // STATELESS VOTING ========================================================

    /// @notice Ensures that voting calculations scale correctly against role multipliers without claiming tokens
    function test_StatelessVoting() public {
        address proposer = makeAddr("proposer");
        address voter = makeAddr("voter");

        vm.prank(proposer);
        core.registerNode(contextUID, "0x");
        vm.prank(voter);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 proposerScore = 50; // Power = 50 * 5 = 250 (Meets 100 threshold)
        uint256 voterScore = 100; // Power = 100 * 1 = 100

        bytes32 leaf1 = keccak256(
            bytes.concat(
                keccak256(abi.encode(contextUID, proposer, ROLE_PROFESSOR, proposerScore, epoch))
            )
        );
        bytes32 leaf2 = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, voter, ROLE_STUDENT, voterScore, epoch)))
        );

        bytes32 root = _hashPair(leaf1, leaf2);

        client.postEpochRoot(
            epoch, root, "", _signEpochRoot(settlerPk, contextUID, epoch, root, address(client))
        );

        bytes32[] memory proposerRoles = new bytes32[](1);
        proposerRoles[0] = ROLE_PROFESSOR;
        uint256[] memory proposerScores = new uint256[](1);
        proposerScores[0] = proposerScore;
        bytes32[][] memory proposerProofs = new bytes32[][](1);
        proposerProofs[0] = new bytes32[](1);
        proposerProofs[0][0] = leaf2;

        vm.startPrank(proposer);
        uint256 proposalId = client.createProposalWithProofs(
            "Stateless Proposal", address(0), "", 3, proposerRoles, proposerScores, proposerProofs
        );
        vm.stopPrank();

        bytes32[] memory voterRoles = new bytes32[](1);
        voterRoles[0] = ROLE_STUDENT;
        uint256[] memory voterScores = new uint256[](1);
        voterScores[0] = voterScore;
        bytes32[][] memory voterProofs = new bytes32[][](1);
        voterProofs[0] = new bytes32[](1);
        voterProofs[0][0] = leaf1;

        vm.prank(voter);
        client.castVoteWithProofs(proposalId, true, voterRoles, voterScores, voterProofs);

        (,,, uint256 votesFor,,,,) = client.getProposal(proposalId);
        assertEq(votesFor, 100);
    }
}
