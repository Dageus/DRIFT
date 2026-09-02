// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTClientFactory } from "../../../src/client/DRIFTClientFactory.sol";
import { IDRIFTGovernance } from "../../../src/client/IDRIFTGovernance.sol";
import { IDRIFTGovernanceProofOfState } from "../../../src/client/IDRIFTGovernanceProofOfState.sol";
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
        client.setEpochLength(EPOCH_LENGTH);
        client.setDisputeWindow(DISPUTE_WINDOW);
        client.setResponseWindow(RESPONSE_WINDOW);
        client.setSettlementBond(SETTLEMENT_BOND);
        vm.stopPrank();
    }

    // B1 test cadence: epochLength must exceed disputeWindow + responseWindow.
    uint256 constant EPOCH_LENGTH = 10;
    uint256 constant DISPUTE_WINDOW = 1;
    uint256 constant RESPONSE_WINDOW = 1;
    uint256 constant SETTLEMENT_BOND = 0.001 ether;
    uint256 constant CHALLENGE_BOND = 0.001 ether;

    /// @dev Rolls past both the current epoch's dispute+response windows so its root is finalized
    ///      and usable by claim/governance reads.
    function _rollPastFinalization(
        WeightedGovernanceClient c
    ) internal {
        vm.warp(block.timestamp + c.disputeWindow() + c.responseWindow() + 1);
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
        vm.prank(admin);
        client.assignRole(node, ROLE_PROFESSOR);

        uint256 epoch = 1;
        uint256 score = 50;

        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, node, ROLE_PROFESSOR, score, epoch)))
        );
        bytes32 root = leaf;
        bytes memory sig = _signEpochRoot(settlerPk, contextUID, epoch, root, address(client));

        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", sig);
        _rollPastFinalization(client);

        bytes32[] memory proof = new bytes32[](0);

        vm.prank(node);
        client.claimReputation(node, ROLE_PROFESSOR, score, epoch, proof);

        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, ROLE_PROFESSOR)));
        assertEq(driftToken.balanceOf(node, tokenId), score);
    }

    /// @notice The client's assignRole/revokeRole pass-throughs are the only production entry
    /// point into DRIFTCore's onlyContextClient-gated role functions — a plain context-admin EOA
    /// is never the client contract itself.
    function test_ClientRoleMembership_AssignRevokeAndReads() public {
        vm.prank(node);
        core.registerNode(contextUID, "0x");

        assertFalse(client.hasNodeRole(node, ROLE_PROFESSOR));

        vm.prank(admin);
        client.assignRole(node, ROLE_PROFESSOR);
        assertTrue(client.hasNodeRole(node, ROLE_PROFESSOR));
        assertEq(client.getNodeRoles(node).length, 1);

        vm.prank(admin);
        client.revokeRole(node, ROLE_PROFESSOR);
        assertFalse(client.hasNodeRole(node, ROLE_PROFESSOR));
        assertEq(client.getNodeRoles(node).length, 0);
    }

    function test_RevertIf_ClientAssignRoleCallerNotContextAdmin() public {
        vm.prank(node);
        core.registerNode(contextUID, "0x");

        vm.prank(node);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTGovernance.UnauthorizedSender.selector, node));
        client.assignRole(node, ROLE_PROFESSOR);
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

        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, root, "", _signEpochRoot(settlerPk, contextUID, epoch, root, address(client))
        );
        _rollPastFinalization(client);

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

    /// @notice initialize must reject a zero-address settler (B3 Slither triage: without this, a
    /// context could be deployed with no address ever able to produce a valid postEpochRoot
    /// signature, silently bricking it instead of failing loudly — mirrors setTrustedSettler's
    /// existing zero-check).
    function test_RevertIf_InitializeWithZeroAddressSettler() public {
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_STUDENT;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            address(0),
            0,
            0,
            "EigenTrust",
            roles,
            weights
        );

        vm.prank(admin);
        vm.expectRevert(WeightedGovernanceClient.ZeroAddressSettler.selector);
        factory.deployClient(contextUID, address(template), initData, bytes32("zerosettlersalt"));
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

        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, root, "", _signEpochRoot(settlerPk, contextUID, epoch, root, address(client))
        );
        _rollPastFinalization(client);

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

        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, root, "", _signEpochRoot(settlerPk, contextUID, epoch, root, address(client))
        );
        _rollPastFinalization(client);

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

    // EPOCH BOUNDARY ENFORCEMENT (A1: on-chain beta/t_0) =====================

    /// @notice Posting before the on-chain boundary timestamp must revert
    function test_RevertIf_PostEpochRootBeforeBoundary() public {
        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig = _signEpochRoot(settlerPk, contextUID, epoch, root, address(client));

        uint256 boundary = client.epochAnchorTimestamp() + client.epochLength() * epoch;

        vm.expectRevert(
            abi.encodeWithSelector(
                WeightedGovernanceClient.EpochNotYetElapsed.selector, boundary, block.timestamp
            )
        );
        client.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", sig);
    }

    /// @notice Posting exactly at the boundary timestamp succeeds
    function test_PostEpochRootSucceedsAtBoundary() public {
        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig = _signEpochRoot(settlerPk, contextUID, epoch, root, address(client));

        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", sig);

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

        vm.startPrank(admin);
        freshClient.setEpochLength(EPOCH_LENGTH);
        freshClient.setDisputeWindow(DISPUTE_WINDOW);
        freshClient.setResponseWindow(RESPONSE_WINDOW);
        freshClient.setSettlementBond(SETTLEMENT_BOND);
        vm.stopPrank();

        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig =
            _signEpochRoot(ownerPk, freshContextUID, epoch, root, address(freshClient));

        vm.warp(freshClient.epochAnchorTimestamp() + freshClient.epochLength() * epoch);
        freshClient.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", sig);

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

        vm.startPrank(admin);
        freshClient.setEpochLength(EPOCH_LENGTH);
        freshClient.setDisputeWindow(DISPUTE_WINDOW);
        freshClient.setResponseWindow(RESPONSE_WINDOW);
        freshClient.setSettlementBond(SETTLEMENT_BOND);
        vm.stopPrank();

        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig =
            _signEpochRoot(ownerPk, freshContextUID, epoch, root, address(freshClient));

        vm.warp(freshClient.epochAnchorTimestamp() + freshClient.epochLength() * epoch);
        vm.expectRevert(IDRIFTSettler.InvalidSettlerSignature.selector);
        freshClient.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", sig);
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

    // ACCESS CONTROL ==========================================================

    function test_RevertIf_SetRoleWeightsCallerNotContextAdmin() public {
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_STUDENT;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;

        vm.prank(node);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTGovernance.UnauthorizedSender.selector, node));
        client.setRoleWeights(roles, weights);
    }

    function test_RevertIf_SetTrustedSettlerCallerNotContextAdmin() public {
        vm.prank(node);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTGovernance.UnauthorizedSender.selector, node));
        client.setTrustedSettler(makeAddr("newSettler"));
    }

    function test_RevertIf_SetTrustedSettlerZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(WeightedGovernanceClient.ZeroAddressSettler.selector);
        client.setTrustedSettler(address(0));
    }

    /// @dev createProposal/castVote (the non-proof-based OZ-Governor-style entry points) are
    ///      permanently disabled in favor of the *WithProofs variants — anyone calling them,
    ///      authorized or not, must always be rejected.
    function test_RevertIf_CreateProposalDisabled() public {
        vm.expectRevert(IDRIFTGovernanceProofOfState.MustUseCreateProposalWithProofs.selector);
        client.createProposal("desc", address(0), "", 1);
    }

    function test_RevertIf_CastVoteDisabled() public {
        vm.expectRevert(IDRIFTGovernanceProofOfState.MustUseCastVoteWithProofs.selector);
        client.castVote(0, true);
    }

    // ADMISSION / CONFIGURATION POLICIES ======================================

    function test_RevertIf_InitializeArrayLengthMismatch() public {
        bytes32[] memory roles = new bytes32[](2);
        roles[0] = ROLE_STUDENT;
        roles[1] = ROLE_PROFESSOR;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;

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
        vm.expectRevert(WeightedGovernanceClient.ArrayLengthMismatch.selector);
        factory.deployClient(contextUID, address(template), initData, bytes32("mismatchsalt"));
    }

    function test_RevertIf_InitializeTooManyRoles() public {
        bytes32[] memory roles = new bytes32[](11);
        uint256[] memory weights = new uint256[](11);
        for (uint256 i = 0; i < 11; i++) {
            roles[i] = keccak256(abi.encode("ROLE", i));
            weights[i] = 0;
        }

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
        vm.expectRevert(WeightedGovernanceClient.MaximumRoleLengthExceeded.selector);
        factory.deployClient(contextUID, address(template), initData, bytes32("toomanysalt"));
    }

    function test_RevertIf_SetRoleWeightsArrayLengthMismatch() public {
        bytes32[] memory roles = new bytes32[](2);
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;

        vm.prank(admin);
        vm.expectRevert(WeightedGovernanceClient.ArrayLengthMismatch.selector);
        client.setRoleWeights(roles, weights);
    }

    function test_RevertIf_SetRoleWeightsTooManyRoles() public {
        bytes32[] memory roles = new bytes32[](11);
        uint256[] memory weights = new uint256[](11);
        for (uint256 i = 0; i < 11; i++) {
            roles[i] = keccak256(abi.encode("ROLE", i));
            weights[i] = 0;
        }

        vm.prank(admin);
        vm.expectRevert(WeightedGovernanceClient.MaximumRoleLengthExceeded.selector);
        client.setRoleWeights(roles, weights);
    }

    function test_RevertIf_DisputeWindowSetTwice() public {
        vm.prank(admin);
        vm.expectRevert(IDRIFTSettler.DisputeWindowAlreadySet.selector);
        client.setDisputeWindow(5);
    }

    function test_RevertIf_DisputeWindowZero() public {
        (WeightedGovernanceClient freshClient,) = _deployFreshClient(settler);

        vm.prank(admin);
        vm.expectRevert(IDRIFTSettler.InvalidDisputeWindow.selector);
        freshClient.setDisputeWindow(0);
    }

    function test_RevertIf_ResponseWindowSetTwice() public {
        vm.prank(admin);
        vm.expectRevert(IDRIFTSettler.ResponseWindowAlreadySet.selector);
        client.setResponseWindow(5);
    }

    function test_RevertIf_ResponseWindowZero() public {
        (WeightedGovernanceClient freshClient,) = _deployFreshClient(settler);

        vm.prank(admin);
        vm.expectRevert(IDRIFTSettler.InvalidResponseWindow.selector);
        freshClient.setResponseWindow(0);
    }

    // EPOCH MONOTONICITY =======================================================

    // NOTE: IDRIFTSettler.EpochAlreadyPosted (postEpochRoot's second guard,
    // `epochRoots[epoch] != 0`) is unreachable via the external API and so cannot be exercised by
    // a test: `currentEpoch` and `epochRoots[currentEpoch]` are only ever written together, in the
    // same call, so for any epoch number that has a root, `epoch != currentEpoch + 1` (the FIRST
    // guard) is already true and fires before this one ever could — including after a B1 rollback,
    // which clears epochRoots[epoch] in the same step it rewinds currentEpoch back to epoch - 1.
    // Flagging this as dead defensive code rather than silently omitting a test for it.

    function test_RevertIf_PostEpochRootInsufficientBond() public {
        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig = _signEpochRoot(settlerPk, contextUID, epoch, root, address(client));

        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.InsufficientBond.selector, SETTLEMENT_BOND - 1, SETTLEMENT_BOND
            )
        );
        client.postEpochRoot{ value: SETTLEMENT_BOND - 1 }(epoch, root, "", sig);
    }

    /// @notice Epoch N+1 cannot post until epoch N is fully finalized (dispute+response windows
    ///         elapsed) — settlement is strictly sequential once a pending/challengeable state
    ///         exists, not just monotonically numbered.
    function test_RevertIf_PostEpochRootPreviousNotFinalized() public {
        uint256 epoch1 = 1;
        bytes32 root1 = keccak256("root1");
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch1);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch1, root1, "", _signEpochRoot(settlerPk, contextUID, epoch1, root1, address(client))
        );
        // Deliberately NOT rolling past dispute+response windows, and deliberately NOT warping to
        // epoch2's own boundary either: the finalization check (guard 8) runs before the
        // boundary-elapsed check (guard 9), so this must revert regardless of whether epoch2's
        // boundary has been reached yet.

        uint256 epoch2 = 2;
        bytes32 root2 = keccak256("root2");
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.EpochNotYetFinalized.selector, epoch1));
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch2, root2, "", _signEpochRoot(settlerPk, contextUID, epoch2, root2, address(client))
        );
    }

    function test_RevertIf_ChallengeOmissionWrongEpoch() public {
        // currentEpoch is 0 (nothing posted yet) — any epoch != 0 must be rejected immediately,
        // before any dispute-window/eligibility/bond check ever runs.
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.EpochNotFound.selector, 1));
        client.challengeOmission(1, makeAddr("missing"));
    }

    // PROOF VERIFICATION =======================================================

    function test_VerifyReputation_ReturnsFalseIfEpochNotFound() public view {
        bytes32[] memory proof = new bytes32[](0);
        assertFalse(client.verifyReputation(node, ROLE_STUDENT, 100, 1, proof));
    }

    function test_VerifyReputation_ReturnsTrueForValidProof() public {
        uint256 epoch = 1;
        uint256 score = 100;
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, node, ROLE_STUDENT, score, epoch)))
        );
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, leaf, "", _signEpochRoot(settlerPk, contextUID, epoch, leaf, address(client))
        );

        bytes32[] memory proof = new bytes32[](0);
        assertTrue(client.verifyReputation(node, ROLE_STUDENT, score, epoch, proof));
    }

    function test_RevertIf_ClaimReputationNodeNotRegistered() public {
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(
            abi.encodeWithSelector(
                WeightedGovernanceClient.NodeNotRegistered.selector, contextUID, node
            )
        );
        client.claimReputation(node, ROLE_STUDENT, 100, 1, proof);
    }

    function test_RevertIf_ClaimReputationEpochNotFound() public {
        vm.prank(node);
        core.registerNode(contextUID, "0x");

        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.EpochNotFound.selector, 1));
        client.claimReputation(node, ROLE_STUDENT, 100, 1, proof);
    }

    function test_RevertIf_ClaimReputationAlreadyClaimed() public {
        vm.prank(node);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(node, ROLE_PROFESSOR);

        uint256 epoch = 1;
        uint256 score = 50;
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, node, ROLE_PROFESSOR, score, epoch)))
        );
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, leaf, "", _signEpochRoot(settlerPk, contextUID, epoch, leaf, address(client))
        );
        _rollPastFinalization(client);

        bytes32[] memory proof = new bytes32[](0);
        vm.prank(node);
        client.claimReputation(node, ROLE_PROFESSOR, score, epoch, proof);

        vm.prank(node);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.AlreadyClaimed.selector, node, ROLE_PROFESSOR, epoch
            )
        );
        client.claimReputation(node, ROLE_PROFESSOR, score, epoch, proof);
    }

    /// @notice claimReputation's slash branch: a later epoch's claimed score below the node's
    ///         current on-chain balance must burn the difference, not just skip the delta.
    function test_ClaimReputation_SlashesWhenScoreDecreases() public {
        vm.prank(node);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(node, ROLE_PROFESSOR);

        uint256 epoch1 = 1;
        uint256 score1 = 100;
        bytes32 leaf1 = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, node, ROLE_PROFESSOR, score1, epoch1)))
        );
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch1);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch1, leaf1, "", _signEpochRoot(settlerPk, contextUID, epoch1, leaf1, address(client))
        );
        _rollPastFinalization(client);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(node);
        client.claimReputation(node, ROLE_PROFESSOR, score1, epoch1, proof);

        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, ROLE_PROFESSOR)));
        assertEq(driftToken.balanceOf(node, tokenId), 100);

        uint256 epoch2 = 2;
        uint256 score2 = 40;
        bytes32 leaf2 = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, node, ROLE_PROFESSOR, score2, epoch2)))
        );
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch2);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch2, leaf2, "", _signEpochRoot(settlerPk, contextUID, epoch2, leaf2, address(client))
        );
        _rollPastFinalization(client);
        vm.prank(node);
        client.claimReputation(node, ROLE_PROFESSOR, score2, epoch2, proof);

        assertEq(driftToken.balanceOf(node, tokenId), 40);
    }

    /// @notice claimReputation with an unchanged score must neither mint nor burn — the delta==0
    ///         "no-op" branch, distinct from both the reward and slash branches.
    function test_ClaimReputation_NoOpWhenScoreUnchanged() public {
        vm.prank(node);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(node, ROLE_PROFESSOR);

        uint256 score = 100;
        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, ROLE_PROFESSOR)));
        bytes32[] memory proof = new bytes32[](0);

        for (uint256 epoch = 1; epoch <= 2; epoch++) {
            bytes32 leaf = keccak256(
                bytes.concat(keccak256(abi.encode(contextUID, node, ROLE_PROFESSOR, score, epoch)))
            );
            vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
            client.postEpochRoot{ value: SETTLEMENT_BOND }(
                epoch, leaf, "", _signEpochRoot(settlerPk, contextUID, epoch, leaf, address(client))
            );
            _rollPastFinalization(client);
            vm.prank(node);
            client.claimReputation(node, ROLE_PROFESSOR, score, epoch, proof);
        }

        assertEq(driftToken.balanceOf(node, tokenId), 100);
    }

    function test_RevertIf_CreateProposalWithProofsNoSettledEpochs() public {
        bytes32[] memory roles = new bytes32[](0);
        uint256[] memory scores = new uint256[](0);
        bytes32[][] memory proofs = new bytes32[][](0);

        vm.prank(node);
        vm.expectRevert(IDRIFTGovernanceProofOfState.NoSettledEpochs.selector);
        client.createProposalWithProofs("desc", address(0), "", 1, roles, scores, proofs);
    }

    function test_RevertIf_CreateProposalWithProofsArrayLengthMismatch() public {
        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, root, "", _signEpochRoot(settlerPk, contextUID, epoch, root, address(client))
        );
        _rollPastFinalization(client);

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_STUDENT;
        uint256[] memory scores = new uint256[](0);
        bytes32[][] memory proofs = new bytes32[][](0);

        vm.prank(node);
        vm.expectRevert(WeightedGovernanceClient.ArrayLengthMismatch.selector);
        client.createProposalWithProofs("desc", address(0), "", 1, roles, scores, proofs);
    }

    function test_RevertIf_CreateProposalWithProofsBelowThreshold() public {
        address proposer = makeAddr("belowThresholdProposer");
        vm.prank(proposer);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 40; // STUDENT weight 2000: 40*2000/10000 = 8 < proposalThreshold (10)
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, proposer, ROLE_STUDENT, score, epoch)))
        );
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, leaf, "", _signEpochRoot(settlerPk, contextUID, epoch, leaf, address(client))
        );
        _rollPastFinalization(client);

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_STUDENT;
        uint256[] memory scores = new uint256[](1);
        scores[0] = score;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.prank(proposer);
        vm.expectRevert(IDRIFTGovernanceProofOfState.BelowProposalThreshold.selector);
        client.createProposalWithProofs("desc", address(0), "", 1, roles, scores, proofs);
    }

    function test_RevertIf_CastVoteWithProofsProposalNotFound() public {
        bytes32[] memory roles = new bytes32[](0);
        uint256[] memory scores = new uint256[](0);
        bytes32[][] memory proofs = new bytes32[][](0);

        vm.expectRevert(abi.encodeWithSelector(IDRIFTGovernance.ProposalNotFound.selector, 999));
        client.castVoteWithProofs(999, true, roles, scores, proofs);
    }

    /// @dev Shared fixture for the castVoteWithProofs revert tests below: settles epoch 1 and
    ///      creates a real proposal from it, returning the proposalId plus the voter's leaf/proof
    ///      material so each test only has to add its own specific twist.
    function _settleAndCreateProposal()
        internal
        returns (uint256 proposalId, bytes32[] memory roles, uint256[] memory scores)
    {
        address proposer = makeAddr("proposalCreator");
        vm.prank(proposer);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 100; // PROFESSOR weight 8000: 100*8000/10000 = 80 >= threshold (10)
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, proposer, ROLE_PROFESSOR, score, epoch)))
        );
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, leaf, "", _signEpochRoot(settlerPk, contextUID, epoch, leaf, address(client))
        );
        _rollPastFinalization(client);

        roles = new bytes32[](1);
        roles[0] = ROLE_PROFESSOR;
        scores = new uint256[](1);
        scores[0] = score;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.prank(proposer);
        proposalId =
            client.createProposalWithProofs("desc", address(0), "", 1, roles, scores, proofs);
    }

    function test_RevertIf_CastVoteWithProofsVotingClosed() public {
        (uint256 proposalId, bytes32[] memory roles, uint256[] memory scores) =
            _settleAndCreateProposal();
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        (,,,,, uint256 deadline,,) = client.getProposal(proposalId);
        vm.warp(deadline);

        vm.expectRevert(abi.encodeWithSelector(IDRIFTGovernance.VotingClosed.selector, deadline));
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);
    }

    function test_RevertIf_CastVoteWithProofsAlreadyVoted() public {
        (uint256 proposalId, bytes32[] memory roles, uint256[] memory scores) =
            _settleAndCreateProposal();
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        address voter = makeAddr("proposalCreator"); // same identity used as the proof's subject
        vm.prank(voter);
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);

        vm.prank(voter);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTGovernance.AlreadyVoted.selector, voter, proposalId)
        );
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);
    }

    function test_RevertIf_CastVoteWithProofsRoleHasNoWeight() public {
        (uint256 proposalId,,) = _settleAndCreateProposal();

        bytes32 unknownRole = keccak256("GHOST_ROLE");
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = unknownRole;
        uint256[] memory scores = new uint256[](1);
        scores[0] = 100;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTGovernanceProofOfState.RoleHasNoWeight.selector, unknownRole
            )
        );
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);
    }

    /// @notice An empty roles/scores/proofs claim is well-formed (arrays all agree at length 0)
    ///         but trivially sums to zero power — the loop body never runs, so no proof is even
    ///         needed to reach this branch.
    function test_RevertIf_CastVoteWithProofsNoVotingPower() public {
        (uint256 proposalId,,) = _settleAndCreateProposal();

        bytes32[] memory emptyRoles = new bytes32[](0);
        uint256[] memory emptyScores = new uint256[](0);
        bytes32[][] memory emptyProofs = new bytes32[][](0);

        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTGovernance.NoVotingPower.selector, address(this))
        );
        client.castVoteWithProofs(proposalId, true, emptyRoles, emptyScores, emptyProofs);
    }

    function test_RevertIf_GetVotingPowerAtEpochArrayLengthMismatch() public {
        vm.prank(node);
        core.registerNode(contextUID, "0x");

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_STUDENT;
        uint256[] memory scores = new uint256[](0);
        bytes32[][] memory proofs = new bytes32[][](0);

        vm.expectRevert(WeightedGovernanceClient.ArrayLengthMismatch.selector);
        client.getVotingPowerAtEpoch(node, 1, roles, scores, proofs);
    }

    function test_GetVotingPowerAtEpoch_ReturnsZeroForUnregisteredAccount() public view {
        bytes32[] memory roles = new bytes32[](0);
        uint256[] memory scores = new uint256[](0);
        bytes32[][] memory proofs = new bytes32[][](0);

        assertEq(client.getVotingPowerAtEpoch(node, 1, roles, scores, proofs), 0);
    }

    function test_RevertIf_GetVotingPowerAtEpochNotFound() public {
        vm.prank(node);
        core.registerNode(contextUID, "0x");

        bytes32[] memory roles = new bytes32[](0);
        uint256[] memory scores = new uint256[](0);
        bytes32[][] memory proofs = new bytes32[][](0);

        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.EpochNotFound.selector, 1));
        client.getVotingPowerAtEpoch(node, 1, roles, scores, proofs);
    }

    function test_RevertIf_GetVotingPowerForProposalNotFound() public {
        bytes32[] memory roles = new bytes32[](0);
        uint256[] memory scores = new uint256[](0);
        bytes32[][] memory proofs = new bytes32[][](0);

        vm.expectRevert(abi.encodeWithSelector(IDRIFTGovernance.ProposalNotFound.selector, 999));
        client.getVotingPowerForProposal(999, node, roles, scores, proofs);
    }

    /// @notice getVotingPowerForProposal never reverts on a bad proof (unlike the mutating
    ///         castVoteWithProofs path) — it silently contributes zero power for that claim.
    function test_GetVotingPowerForProposal_SkipsInvalidProofsSilently() public {
        (uint256 proposalId,,) = _settleAndCreateProposal();

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_PROFESSOR;
        uint256[] memory scores = new uint256[](1);
        scores[0] = 999; // does not match the leaf actually in the tree
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        uint256 power = client.getVotingPowerForProposal(
            proposalId, makeAddr("proposalCreator"), roles, scores, proofs
        );
        assertEq(power, 0);
    }

    // PROPOSAL EXECUTION =======================================================

    function test_RevertIf_ExecuteProposalNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(IDRIFTGovernance.ProposalNotFound.selector, 999));
        client.executeProposal(999);
    }

    function test_RevertIf_ExecuteProposalVotingStillActive() public {
        (uint256 proposalId,,) = _settleAndCreateProposal();
        (,,,,, uint256 deadline,,) = client.getProposal(proposalId);

        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTGovernance.VotingStillActive.selector, deadline)
        );
        client.executeProposal(proposalId);
    }

    function test_RevertIf_ExecuteProposalDefeated() public {
        (uint256 proposalId,,) = _settleAndCreateProposal();
        (,,,,, uint256 deadline,,) = client.getProposal(proposalId);
        vm.warp(deadline);

        // No votes cast at all: votesFor (0) <= votesAgainst (0).
        vm.expectRevert(abi.encodeWithSelector(IDRIFTGovernance.ProposalDefeated.selector, 0, 0));
        client.executeProposal(proposalId);
    }

    function test_RevertIf_ExecuteProposalQuorumNotReached() public {
        vm.prank(admin);
        client.setQuorumThreshold(1_000_000);

        (uint256 proposalId, bytes32[] memory roles, uint256[] memory scores) =
            _settleAndCreateProposal();
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        address voter = makeAddr("proposalCreator");
        vm.prank(voter);
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);

        (,,, uint256 votesFor, uint256 votesAgainst, uint256 deadline,,) =
            client.getProposal(proposalId);
        vm.warp(deadline);

        vm.expectRevert(
            abi.encodeWithSelector(
                WeightedGovernanceClient.QuorumNotReached.selector,
                votesFor + votesAgainst,
                1_000_000
            )
        );
        client.executeProposal(proposalId);
    }

    function test_ExecuteProposal_Succeeds() public {
        (uint256 proposalId, bytes32[] memory roles, uint256[] memory scores) =
            _settleAndCreateProposal();
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.prank(makeAddr("proposalCreator"));
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);

        (,,,,, uint256 deadline,,) = client.getProposal(proposalId);
        vm.warp(deadline);

        client.executeProposal(proposalId);

        (,,,,,, bool executed,) = client.getProposal(proposalId);
        assertTrue(executed);
    }

    function test_RevertIf_ExecuteProposalAlreadyExecuted() public {
        (uint256 proposalId, bytes32[] memory roles, uint256[] memory scores) =
            _settleAndCreateProposal();
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.prank(makeAddr("proposalCreator"));
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);

        (,,,,, uint256 deadline,,) = client.getProposal(proposalId);
        vm.warp(deadline);
        client.executeProposal(proposalId);

        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTGovernance.ProposalAlreadyExecuted.selector, proposalId)
        );
        client.executeProposal(proposalId);
    }

    /// @notice A passing, quorum-met proposal whose target call itself reverts must surface
    ///         ExecutionFailed rather than silently leaving `executed` unset with no signal.
    function test_RevertIf_ExecuteProposal_TargetCallFails() public {
        address proposer = makeAddr("failingTargetProposer");
        vm.prank(proposer);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 100;
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, proposer, ROLE_PROFESSOR, score, epoch)))
        );
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, leaf, "", _signEpochRoot(settlerPk, contextUID, epoch, leaf, address(client))
        );
        _rollPastFinalization(client);

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_PROFESSOR;
        uint256[] memory scores = new uint256[](1);
        scores[0] = score;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        // Target the client itself with a call guaranteed to revert: epochLength was already set
        // in setUp, so calling setEpochLength again always reverts EpochLengthAlreadySet.
        bytes memory payload =
            abi.encodeWithSelector(WeightedGovernanceClient.setEpochLength.selector, 999);

        vm.prank(proposer);
        uint256 proposalId = client.createProposalWithProofs(
            "fails", address(client), payload, 1, roles, scores, proofs
        );

        vm.prank(proposer);
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);

        (,,,,, uint256 deadline,,) = client.getProposal(proposalId);
        vm.warp(deadline);

        vm.expectRevert(IDRIFTGovernance.ExecutionFailed.selector);
        client.executeProposal(proposalId);
    }

    function test_RevertIf_CreateProposalWithProofsInvalidMerkleProof() public {
        address proposer = makeAddr("badProofProposer");
        vm.prank(proposer);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        bytes32 root = keccak256("some-other-root");
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, root, "", _signEpochRoot(settlerPk, contextUID, epoch, root, address(client))
        );
        _rollPastFinalization(client);

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_PROFESSOR;
        uint256[] memory scores = new uint256[](1);
        scores[0] = 100;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0); // doesn't verify against `root`, which isn't this leaf

        vm.prank(proposer);
        vm.expectRevert(IDRIFTSettler.InvalidMerkleProof.selector);
        client.createProposalWithProofs("desc", address(0), "", 1, roles, scores, proofs);
    }

    function test_CastVoteWithProofs_AgainstBranch() public {
        (uint256 proposalId, bytes32[] memory roles, uint256[] memory scores) =
            _settleAndCreateProposal();
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.prank(makeAddr("proposalCreator"));
        client.castVoteWithProofs(proposalId, false, roles, scores, proofs);

        (,,, uint256 votesFor, uint256 votesAgainst,,,) = client.getProposal(proposalId);
        assertEq(votesFor, 0);
        assertEq(votesAgainst, 80); // 100 * 8000 / 10000
    }

    function test_RevertIf_GetVotingPowerAtEpochInvalidMerkleProof() public {
        vm.prank(node);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        bytes32 root = keccak256("unrelated-root");
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, root, "", _signEpochRoot(settlerPk, contextUID, epoch, root, address(client))
        );
        _rollPastFinalization(client);

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE_STUDENT;
        uint256[] memory scores = new uint256[](1);
        scores[0] = 100;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.expectRevert(IDRIFTSettler.InvalidMerkleProof.selector);
        client.getVotingPowerAtEpoch(node, epoch, roles, scores, proofs);
    }
}
