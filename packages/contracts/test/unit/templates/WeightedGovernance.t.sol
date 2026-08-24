// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTClientFactory } from "../../../src/client/DRIFTClientFactory.sol";
import { IDRIFTSettler } from "../../../src/client/IDRIFTSettler.sol";
import { DRIFTCore } from "../../../src/core/DRIFTCore.sol";
import { WeightedGovernanceClient } from "../../../src/templates/WeightedGovernance.sol";
import { DRIFTToken } from "../../../src/token/DRIFTToken.sol";
import { MockERC1271Signer } from "../../mocks/MockERC1271Signer.sol";
import { DRIFTTestHelper } from "../../utils/DRIFTTestHelper.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract WeightedGovernanceClientTest is DRIFTTestHelper {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public client;
    WeightedGovernanceClient public template;

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

        template = new WeightedGovernanceClient();
        factory = new DRIFTClientFactory(address(core));

        vm.startPrank(admin);
        contextUID = core.registerContext("test.university");
        core.grantRole(core.FACTORY_ROLE(), address(factory));
        vm.stopPrank();

        bytes32[] memory roles = new bytes32[](2);
        roles[0] = ROLE_STUDENT;
        roles[1] = ROLE_PROFESSOR;

        uint256[] memory weights = new uint256[](2);
        weights[0] = 2000; // STUDENT: 20%
        weights[1] = 8000; // PROFESSOR: 80%

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            settler,
            10,
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
        client.setEpochLength(1);
        vm.stopPrank();
    }

    // INITIALIZATION ==========================================================

    /// @notice Verifies client constructor and initializers correctly load arrays
    function test_InitializationSetsWeights() public view {
        assertEq(client.roleWeights(ROLE_STUDENT), 2000);
        assertEq(client.roleWeights(ROLE_PROFESSOR), 8000);
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

        vm.roll(block.number + epoch);
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
        uint256 proposerScore = 50; // 50 * 8000 / 10000 = 40
        uint256 voterScore = 100; // 100 * 2000 / 10000 = 20

        bytes32 leaf1 = keccak256(
            bytes.concat(
                keccak256(abi.encode(contextUID, proposer, ROLE_PROFESSOR, proposerScore, epoch))
            )
        );
        bytes32 leaf2 = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, voter, ROLE_STUDENT, voterScore, epoch)))
        );

        bytes32 root = _hashPair(leaf1, leaf2);

        vm.roll(block.number + epoch);
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
        assertEq(votesFor, 20);
    }

    // ROLE WEIGHT NORMALIZATION & PINNING (A4) ================================

    /// @notice initialize() must reject weights that don't sum to WEIGHT_SCALE
    function test_RevertIf_InitializeWeightsNotNormalized() public {
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_STUDENT;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 9999;

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            settler,
            0,
            0,
            "EigenTrust",
            roles,
            weights
        );

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                WeightedGovernanceClient.WeightsNotNormalized.selector, 9999, 10_000
            )
        );
        factory.deployClient(contextUID, address(template), initData, bytes32("badsalt"));
    }

    /// @notice setRoleWeights must reject weights that don't sum to WEIGHT_SCALE
    function test_RevertIf_SetRoleWeightsNotNormalized() public {
        bytes32[] memory roles = new bytes32[](2);
        roles[0] = ROLE_STUDENT;
        roles[1] = ROLE_PROFESSOR;
        uint256[] memory weights = new uint256[](2);
        weights[0] = 5000;
        weights[1] = 4000;

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                WeightedGovernanceClient.WeightsNotNormalized.selector, 9000, 10_000
            )
        );
        client.setRoleWeights(roles, weights);
    }

    /// @notice setRoleWeights fully replaces the active role set and bumps the config version
    function test_SetRoleWeights_ReplacesActiveRolesAndVersion() public {
        bytes32 roleTA = keccak256("TA");
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = roleTA;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;

        uint32 versionBefore = client.currentConfigVersion();

        vm.prank(admin);
        client.setRoleWeights(roles, weights);

        assertEq(client.currentConfigVersion(), versionBefore + 1);
        assertEq(client.roleWeights(roleTA), 10_000);
        assertEq(client.roleWeights(ROLE_STUDENT), 0);

        bytes32[] memory active = client.getActiveRoles();
        assertEq(active.length, 1);
        assertEq(active[0], roleTA);
    }

    /// @notice A weight change after an epoch settles must not alter that epoch's already-pinned
    ///         proposal/vote power — this is the JIT-weight-change fix (A4).
    function test_JITWeightChange_DoesNotAffectPinnedProposal() public {
        address proposer = makeAddr("proposer2");
        address voter = makeAddr("voter2");

        vm.prank(proposer);
        core.registerNode(contextUID, "0x");
        vm.prank(voter);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 proposerScore = 50; // PROFESSOR, weight 8000 at settlement time
        uint256 voterScore = 100; // STUDENT, weight 2000 at settlement time

        bytes32 leafProposer = keccak256(
            bytes.concat(
                keccak256(abi.encode(contextUID, proposer, ROLE_PROFESSOR, proposerScore, epoch))
            )
        );
        bytes32 leafVoter = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, voter, ROLE_STUDENT, voterScore, epoch)))
        );
        bytes32 root = _hashPair(leafProposer, leafVoter);

        vm.roll(block.number + epoch);
        client.postEpochRoot(
            epoch, root, "", _signEpochRoot(settlerPk, contextUID, epoch, root, address(client))
        );

        // Admin changes weights AFTER epoch 1 settled, BEFORE the proposal is created/voted on.
        bytes32[] memory newRoles = new bytes32[](2);
        newRoles[0] = ROLE_STUDENT;
        newRoles[1] = ROLE_PROFESSOR;
        uint256[] memory newWeights = new uint256[](2);
        newWeights[0] = 9000; // flipped from 2000
        newWeights[1] = 1000; // flipped from 8000
        vm.prank(admin);
        client.setRoleWeights(newRoles, newWeights);

        bytes32[] memory proposerRoles = new bytes32[](1);
        proposerRoles[0] = ROLE_PROFESSOR;
        uint256[] memory proposerScores = new uint256[](1);
        proposerScores[0] = proposerScore;
        bytes32[][] memory proposerProofs = new bytes32[][](1);
        proposerProofs[0] = new bytes32[](1);
        proposerProofs[0][0] = leafVoter;

        vm.prank(proposer);
        uint256 proposalId = client.createProposalWithProofs(
            "JIT Test", address(0), "", 3, proposerRoles, proposerScores, proposerProofs
        );

        // Proposal must be pinned to the config version active when epoch 1 settled (version 0),
        // not the version bumped by the post-settlement weight change (version 1).
        (, uint32 configVersion) = client.getProposalSnapshot(proposalId);
        assertEq(configVersion, 0);

        bytes32[] memory voterRoles = new bytes32[](1);
        voterRoles[0] = ROLE_STUDENT;
        uint256[] memory voterScores = new uint256[](1);
        voterScores[0] = voterScore;
        bytes32[][] memory voterProofs = new bytes32[][](1);
        voterProofs[0] = new bytes32[](1);
        voterProofs[0][0] = leafProposer;

        vm.prank(voter);
        client.castVoteWithProofs(proposalId, true, voterRoles, voterScores, voterProofs);

        (,,, uint256 votesFor,,,,) = client.getProposal(proposalId);
        // Old (pinned) weight: 100 * 2000 / 10000 = 20. A live-weight bug would instead give
        // 100 * 9000 / 10000 = 90.
        assertEq(votesFor, 20);
    }

    /// @notice getVotingPowerAtEpoch must resolve the weight config active at the queried epoch,
    ///         not whatever is live now.
    function test_GetVotingPowerAtEpoch_UsesEpochPinnedWeights() public {
        address voter = makeAddr("voter3");
        vm.prank(voter);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 100;
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, voter, ROLE_STUDENT, score, epoch)))
        );
        bytes32 root = leaf;

        vm.roll(block.number + epoch);
        client.postEpochRoot(
            epoch, root, "", _signEpochRoot(settlerPk, contextUID, epoch, root, address(client))
        );

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_STUDENT;
        uint256[] memory scores = new uint256[](1);
        scores[0] = score;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        uint256 powerBefore = client.getVotingPowerAtEpoch(voter, epoch, roles, scores, proofs);
        assertEq(powerBefore, 20); // 100 * 2000 / 10000

        bytes32[] memory newRoles = new bytes32[](2);
        newRoles[0] = ROLE_STUDENT;
        newRoles[1] = ROLE_PROFESSOR;
        uint256[] memory newWeights = new uint256[](2);
        newWeights[0] = 9000;
        newWeights[1] = 1000;
        vm.prank(admin);
        client.setRoleWeights(newRoles, newWeights);

        uint256 powerAfter = client.getVotingPowerAtEpoch(voter, epoch, roles, scores, proofs);
        assertEq(powerAfter, powerBefore);
    }

    // EPOCH BOUNDARY ENFORCEMENT (A1: on-chain beta/h_0) =====================

    /// @notice Posting before the on-chain boundary block must revert
    function test_RevertIf_PostEpochRootBeforeBoundary() public {
        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig = _signEpochRoot(settlerPk, contextUID, epoch, root, address(client));

        uint256 boundary = client.epochAnchorBlock() + client.epochLength() * epoch;

        vm.expectRevert(
            abi.encodeWithSelector(
                WeightedGovernanceClient.EpochNotYetElapsed.selector, boundary, block.number
            )
        );
        client.postEpochRoot(epoch, root, "", sig);
    }

    /// @notice Posting exactly at the boundary block succeeds
    function test_PostEpochRootSucceedsAtBoundary() public {
        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig = _signEpochRoot(settlerPk, contextUID, epoch, root, address(client));

        vm.roll(client.epochAnchorBlock() + client.epochLength() * epoch);
        client.postEpochRoot(epoch, root, "", sig);

        assertEq(client.epochRoots(epoch), root);
    }

    /// @notice epochLength is fixed exactly once; a second call must revert
    function test_RevertIf_EpochLengthSetTwice() public {
        vm.prank(admin);
        vm.expectRevert(WeightedGovernanceClient.EpochLengthAlreadySet.selector);
        client.setEpochLength(5);
    }

    /// @notice epochLength must be non-zero
    function test_RevertIf_EpochLengthIsZero() public {
        (WeightedGovernanceClient freshClient,) = _deployFreshClient(settler);

        vm.prank(admin);
        vm.expectRevert(WeightedGovernanceClient.InvalidEpochLength.selector);
        freshClient.setEpochLength(0);
    }

    /// @notice postEpochRoot must revert if epochLength was never configured
    function test_RevertIf_PostEpochRootWithoutEpochLength() public {
        (WeightedGovernanceClient freshClient, bytes32 freshContextUID) =
            _deployFreshClient(settler);

        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig =
            _signEpochRoot(settlerPk, freshContextUID, epoch, root, address(freshClient));

        vm.expectRevert(WeightedGovernanceClient.EpochLengthNotConfigured.selector);
        freshClient.postEpochRoot(epoch, root, "", sig);
    }

    // SETTLEMENT AUTHORITY (A2: ERC-1271 smart contract settlers) ============

    /// @notice A trustedSettler pointed at an ERC-1271 wallet (e.g. a Safe) can settle epochs
    function test_PostEpochRoot_AcceptsERC1271SmartContractSettler() public {
        uint256 ownerPk = 0x5678;
        address owner = vm.addr(ownerPk);
        MockERC1271Signer wallet = new MockERC1271Signer(owner);

        (WeightedGovernanceClient freshClient, bytes32 freshContextUID) =
            _deployFreshClient(address(wallet));

        vm.prank(admin);
        freshClient.setEpochLength(1);

        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig =
            _signEpochRoot(ownerPk, freshContextUID, epoch, root, address(freshClient));

        vm.roll(freshClient.epochAnchorBlock() + freshClient.epochLength() * epoch);
        freshClient.postEpochRoot(epoch, root, "", sig);

        assertEq(freshClient.epochRoots(epoch), root);
    }

    /// @notice An ERC-1271 wallet that rejects the signature must block settlement
    function test_RevertIf_ERC1271SettlerRejectsSignature() public {
        uint256 ownerPk = 0x5678;
        address owner = vm.addr(ownerPk);
        MockERC1271Signer wallet = new MockERC1271Signer(owner);
        wallet.setRejectAll(true);

        (WeightedGovernanceClient freshClient, bytes32 freshContextUID) =
            _deployFreshClient(address(wallet));

        vm.prank(admin);
        freshClient.setEpochLength(1);

        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig =
            _signEpochRoot(ownerPk, freshContextUID, epoch, root, address(freshClient));

        vm.roll(freshClient.epochAnchorBlock() + freshClient.epochLength() * epoch);
        vm.expectRevert(IDRIFTSettler.InvalidSettlerSignature.selector);
        freshClient.postEpochRoot(epoch, root, "", sig);
    }

    // INTERNAL HELPERS ========================================================

    /// @dev Deploys a second context + governance client clone with a caller-chosen trustedSettler,
    ///      leaving epochLength unconfigured so callers can exercise that transition explicitly.
    function _deployFreshClient(
        address trustedSettlerAddr
    ) internal returns (WeightedGovernanceClient freshClient, bytes32 freshContextUID) {
        vm.startPrank(admin);
        freshContextUID = core.registerContext(
            string(abi.encodePacked("test.university.", block.number, gasleft()))
        );

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_STUDENT;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            freshContextUID,
            trustedSettlerAddr,
            100,
            0,
            "EigenTrust",
            roles,
            weights
        );

        bytes32 adminRole = core.contextAdminRole(freshContextUID);
        core.grantRole(adminRole, admin);
        address cloneAddr = factory.deployClient(
            freshContextUID, address(template), initData, bytes32(block.number)
        );
        freshClient = WeightedGovernanceClient(cloneAddr);
        core.grantRole(adminRole, address(freshClient));
        vm.stopPrank();
    }
}
