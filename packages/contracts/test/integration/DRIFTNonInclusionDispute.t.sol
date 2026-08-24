// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTClientFactory } from "../../src/client/DRIFTClientFactory.sol";
import { IDRIFTSettler } from "../../src/client/IDRIFTSettler.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { NodeStatus } from "../../src/policies/IPolicy.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { MockReentrantChallenger } from "../mocks/MockReentrantChallenger.sol";
import { DRIFTTestHelper } from "../utils/DRIFTTestHelper.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title DRIFTNonInclusionDisputeTest
/// @notice B1: interactive challenge-response non-inclusion disputes.
contract DRIFTNonInclusionDisputeTest is DRIFTTestHelper {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public template;
    WeightedGovernanceClient public client;

    address public admin = makeAddr("admin");
    uint256 public settlerPk = 0x1234;
    address public settler = vm.addr(settlerPk);

    bytes32 public contextUID;
    bytes32 constant ROLE = keccak256("ROLE");

    // Allows this contract to itself act as a bond-receiving party (challenger/settler) in tests
    // that don't route through a separate EOA/mock.
    receive() external payable { }

    uint256 constant EPOCH_LENGTH = 10;
    uint256 constant DISPUTE_WINDOW = 2;
    uint256 constant RESPONSE_WINDOW = 2;
    uint256 constant SETTLEMENT_BOND = 0.01 ether;
    uint256 constant CHALLENGE_BOND = 0.01 ether;

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

        template = new WeightedGovernanceClient();
        factory = new DRIFTClientFactory(address(core));

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), address(factory));
        contextUID = core.registerContext("nid.test");

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
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

        address cloneAddr =
            factory.deployClient(contextUID, address(template), initData, bytes32("salt"));
        client = WeightedGovernanceClient(cloneAddr);
        core.grantRole(core.contextAdminRole(contextUID), address(client));
        client.setEpochLength(EPOCH_LENGTH);
        client.setDisputeWindow(DISPUTE_WINDOW);
        client.setResponseWindow(RESPONSE_WINDOW);
        client.setSettlementBond(SETTLEMENT_BOND);
        client.setChallengeBond(CHALLENGE_BOND);
        vm.stopPrank();
    }

    // HELPERS =================================================================

    function _leaf(
        address node,
        uint256 score,
        uint256 epoch
    ) internal view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(contextUID, node, ROLE, score, epoch))));
    }

    function _boundary(
        uint256 epoch
    ) internal view returns (uint256) {
        return client.epochAnchorBlock() + client.epochLength() * epoch;
    }

    function _postEpoch(
        uint256 epoch,
        bytes32 root
    ) internal {
        vm.roll(_boundary(epoch));
        bytes memory sig = _signEpochRoot(settlerPk, contextUID, epoch, root, address(client));
        client.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", sig);
    }

    function _rollPastFinalization() internal {
        vm.roll(block.number + DISPUTE_WINDOW + RESPONSE_WINDOW + 1);
    }

    // CHALLENGE / RESPONSE ====================================================

    /// @notice A challenge against a node that genuinely has a leaf is defeated by a valid
    ///         inclusion proof; the challenger's bond is forfeited to the settler and the root
    ///         is untouched.
    function test_ChallengeDefeated_ValidResponse() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 100;
        _postEpoch(epoch, _leaf(nodeA, score, epoch));

        address challenger = makeAddr("challenger");
        vm.deal(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA);

        assertEq(client.openChallengeCount(epoch), 1);

        uint256 settlerBalanceBefore = settler.balance;
        client.respondToChallenge(epoch, nodeA, ROLE, score, new bytes32[](0));

        assertEq(client.openChallengeCount(epoch), 0);
        assertEq(settler.balance, settlerBalanceBefore + CHALLENGE_BOND);
        assertEq(client.epochRoots(epoch), _leaf(nodeA, score, epoch));

        (,,, bool resolved) = client.challenges(epoch, nodeA);
        assertTrue(resolved);
    }

    /// @notice A challenge against a genuinely omitted node, left unanswered past the response
    ///         window, rolls the epoch back and pays the settler's bond to the challenger. A
    ///         corrected root can then be re-posted with a fresh bond, restarting both windows.
    function test_ChallengeSucceeds_UnansweredTimeout_ThenRepost() public {
        address nodeA = makeAddr("nodeA");
        address missingNode = makeAddr("missingNode");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 100;
        // Bad root: only nodeA's leaf, missingNode omitted entirely.
        _postEpoch(epoch, _leaf(nodeA, score, epoch));

        address challenger = makeAddr("challenger");
        vm.deal(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode);

        vm.roll(block.number + RESPONSE_WINDOW + 1);

        uint256 challengerBalanceBefore = challenger.balance;
        client.claimUnansweredChallenge(epoch, missingNode);

        assertEq(challenger.balance, challengerBalanceBefore + SETTLEMENT_BOND);
        assertEq(client.epochRoots(epoch), bytes32(0));
        assertEq(client.currentEpoch(), 0);
        assertEq(client.epochPostedAtBlock(epoch), 0);
        assertEq(client.epochBondAmount(epoch), 0);
        assertEq(client.consecutiveFailedEpochs(), 1);

        // Corrected root, including both nodes, fresh bond.
        bytes32 leafA = _leaf(nodeA, score, epoch);
        bytes32 leafMissing = _leaf(missingNode, score, epoch);
        bytes32 correctedRoot = _hashPair(leafA, leafMissing);
        _postEpoch(epoch, correctedRoot);

        assertEq(client.epochRoots(epoch), correctedRoot);
        assertEq(client.currentEpoch(), epoch);
        // The repost finalized cleanly (no rollback of *this* posting), resetting the counter.
        _rollPastFinalization();
        vm.prank(nodeA);
        client.claimReputation(nodeA, ROLE, score, epoch, _proofFor(leafMissing));
    }

    function _proofFor(
        bytes32 sibling
    ) internal pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = sibling;
    }

    /// @notice Concurrent challenges against different nodes in the same epoch resolve
    ///         independently: an early valid response is unaffected by a later, unrelated
    ///         challenge timing out and rolling the epoch back. A third challenge still open at
    ///         rollback time becomes moot and is refunded via `reclaimMootChallenge`, not
    ///         forfeited either direction.
    function test_ConcurrentChallenges_IndependentResolutionAndMootRefund() public {
        address nodeA = makeAddr("nodeA"); // has a leaf, will be defeated by response
        address nodeB = makeAddr("nodeB"); // has a leaf, challenge left open -> moot on rollback
        address nodeC = makeAddr("nodeC"); // genuinely missing -> times out, rolls back
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(nodeB);
        core.registerNode(contextUID, "0x");
        vm.prank(nodeC);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 100;
        bytes32 leafA = _leaf(nodeA, score, epoch);
        bytes32 leafB = _leaf(nodeB, score, epoch);
        // nodeC has no leaf at all.
        bytes32 root = _hashPair(leafA, leafB);
        _postEpoch(epoch, root);

        address challengerA = makeAddr("challengerA");
        address challengerB = makeAddr("challengerB");
        address challengerC = makeAddr("challengerC");
        vm.deal(challengerA, CHALLENGE_BOND);
        vm.deal(challengerB, CHALLENGE_BOND);
        vm.deal(challengerC, CHALLENGE_BOND);

        vm.prank(challengerA);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA);
        vm.prank(challengerB);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeB);
        vm.prank(challengerC);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeC);

        assertEq(client.openChallengeCount(epoch), 3);

        // A's challenge is defeated early — unaffected by what happens to B and C later.
        client.respondToChallenge(epoch, nodeA, ROLE, score, _proofFor(leafB));
        assertEq(client.openChallengeCount(epoch), 2);

        // C's response window expires unanswered — rolls the epoch back.
        vm.roll(block.number + RESPONSE_WINDOW + 1);
        uint256 challengerCBalanceBefore = challengerC.balance;
        client.claimUnansweredChallenge(epoch, nodeC);
        assertEq(challengerC.balance, challengerCBalanceBefore + SETTLEMENT_BOND);
        assertEq(client.epochRoots(epoch), bytes32(0));

        // B's still-open challenge is now moot: refund, no forfeiture either direction.
        uint256 challengerBBalanceBefore = challengerB.balance;
        client.reclaimMootChallenge(epoch, nodeB);
        assertEq(challengerB.balance, challengerBBalanceBefore + CHALLENGE_BOND);
        assertEq(client.openChallengeCount(epoch), 0);
    }

    // ELIGIBILITY (boundary-aware, DRIFTCore) =================================

    /// @notice A node registered *after* the epoch boundary cannot be the subject of a dispute —
    ///         they weren't part of A_c^E, so there's nothing to have been omitted.
    function test_RevertIf_ChallengeIneligible_RegisteredAfterBoundary() public {
        uint256 epoch = 1;
        address early = makeAddr("early");
        vm.prank(early);
        core.registerNode(contextUID, "0x");
        _postEpoch(epoch, _leaf(early, 100, epoch));

        vm.roll(block.number + 1); // strictly after the boundary block

        address late = makeAddr("late");
        vm.prank(late);
        core.registerNode(contextUID, "0x"); // registers AFTER the boundary already passed

        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.NodeNotEligibleForDispute.selector, late)
        );
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, late);
    }

    /// @notice A node banned *after* the boundary must still be disputable — banning it after the
    ///         fact must not let a colluding admin strip a legitimately-omitted node's standing.
    function test_ChallengeEligible_BannedAfterBoundary() public {
        address victim = makeAddr("victim");
        vm.prank(victim);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        // victim omitted from the root entirely.
        address other = makeAddr("other");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        _postEpoch(epoch, _leaf(other, 100, epoch));
        vm.roll(block.number + 1); // strictly after the boundary block

        vm.prank(admin);
        core.setNodeStatus(contextUID, victim, NodeStatus.BANNED);

        // Must NOT revert: victim was registered before the boundary and only banned after it.
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, victim);
        assertEq(client.openChallengeCount(epoch), 1);
    }

    // WINDOW BOUNDARIES ========================================================

    function test_RevertIf_ChallengeWindowClosed() public {
        address missingNode = makeAddr("missingNode");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");

        address other = makeAddr("other");
        vm.prank(other);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        vm.roll(block.number + DISPUTE_WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.DisputeWindowClosed.selector, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode);
    }

    function test_RevertIf_ClaimUnansweredChallenge_ResponseWindowStillOpen() public {
        address missingNode = makeAddr("missingNode");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");
        address other = makeAddr("other");
        vm.prank(other);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.ResponseWindowStillOpen.selector, epoch, missingNode
            )
        );
        client.claimUnansweredChallenge(epoch, missingNode);
    }

    // SEQUENTIAL SETTLEMENT ====================================================

    function test_RevertIf_WindowsExceedEpochLength() public {
        (WeightedGovernanceClient freshClient,) = _deployFreshClient();

        vm.startPrank(admin);
        freshClient.setEpochLength(3);
        freshClient.setDisputeWindow(2);
        freshClient.setResponseWindow(2); // 2 + 2 == 4 > epochLength(3)
        freshClient.setSettlementBond(SETTLEMENT_BOND);
        vm.stopPrank();

        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig =
            _signEpochRoot(settlerPk, freshClient.contextUID(), epoch, root, address(freshClient));

        vm.roll(freshClient.epochAnchorBlock() + freshClient.epochLength() * epoch);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.WindowsExceedEpochLength.selector, uint256(3), uint256(2), uint256(2)
            )
        );
        freshClient.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", sig);
    }

    // BOND FLOORS ==============================================================

    function test_RevertIf_SettlementBondBelowFloor() public {
        uint256 floor = client.MIN_SETTLEMENT_BOND();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.BondBelowFloor.selector, 1, floor));
        client.setSettlementBond(1);
    }

    function test_RevertIf_ChallengeBondBelowFloor() public {
        uint256 floor = client.MIN_CHALLENGE_BOND();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.BondBelowFloor.selector, 1, floor));
        client.setChallengeBond(1);
    }

    /// @notice A never-configured settlementBond (left at its zero default) must not silently
    ///         allow posting with no economic backing at all.
    function test_RevertIf_PostEpochRootWithZeroBondDefault() public {
        (WeightedGovernanceClient freshClient,) = _deployFreshClient();

        vm.startPrank(admin);
        freshClient.setEpochLength(EPOCH_LENGTH);
        freshClient.setDisputeWindow(DISPUTE_WINDOW);
        freshClient.setResponseWindow(RESPONSE_WINDOW);
        // settlementBond deliberately left unconfigured (0).
        vm.stopPrank();

        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        bytes memory sig =
            _signEpochRoot(settlerPk, freshClient.contextUID(), epoch, root, address(freshClient));

        vm.roll(freshClient.epochAnchorBlock() + freshClient.epochLength() * epoch);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.BondBelowFloor.selector, 0, freshClient.MIN_SETTLEMENT_BOND()
            )
        );
        freshClient.postEpochRoot(epoch, root, "", sig);
    }

    // GATING ===================================================================

    function test_RevertIf_ClaimReputation_BeforeFinalized() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 100;
        _postEpoch(epoch, _leaf(nodeA, score, epoch));

        vm.prank(nodeA);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.EpochNotYetFinalized.selector, epoch));
        client.claimReputation(nodeA, ROLE, score, epoch, new bytes32[](0));
    }

    function test_ClaimReputation_SucceedsAfterFinalized() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 100;
        _postEpoch(epoch, _leaf(nodeA, score, epoch));
        _rollPastFinalization();

        vm.prank(nodeA);
        client.claimReputation(nodeA, ROLE, score, epoch, new bytes32[](0));

        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, ROLE)));
        assertEq(driftToken.balanceOf(nodeA, tokenId), score);
    }

    function test_RevertIf_GetVotingPowerAtEpoch_BeforeFinalized() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 100;
        _postEpoch(epoch, _leaf(nodeA, score, epoch));

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory scores = new uint256[](1);
        scores[0] = score;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.EpochNotYetFinalized.selector, epoch));
        client.getVotingPowerAtEpoch(nodeA, epoch, roles, scores, proofs);
    }

    function test_GetVotingPowerAtEpoch_SucceedsAfterFinalized() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 100;
        _postEpoch(epoch, _leaf(nodeA, score, epoch));
        _rollPastFinalization();

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory scores = new uint256[](1);
        scores[0] = score;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        assertEq(client.getVotingPowerAtEpoch(nodeA, epoch, roles, scores, proofs), score);
    }

    // BOND WITHDRAWAL ==========================================================

    function test_WithdrawSettlementBond_AfterFinalized() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));
        _rollPastFinalization();

        uint256 settlerBalanceBefore = settler.balance;
        client.withdrawSettlementBond(epoch);
        assertEq(settler.balance, settlerBalanceBefore + SETTLEMENT_BOND);
        assertEq(client.epochBondAmount(epoch), 0);
    }

    function test_RevertIf_WithdrawSettlementBond_TooEarly() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));

        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.EpochNotYetFinalized.selector, epoch));
        client.withdrawSettlementBond(epoch);
    }

    function test_RevertIf_WithdrawSettlementBond_Twice() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));
        _rollPastFinalization();

        client.withdrawSettlementBond(epoch);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.NoBondToWithdraw.selector, epoch));
        client.withdrawSettlementBond(epoch);
    }

    // CONSECUTIVE FAILURE TRACKING =============================================

    function test_ConsecutiveFailedEpochs_AccumulatesAndResets() public {
        address other = makeAddr("other");
        address missingNode = makeAddr("missingNode");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode);
        vm.roll(block.number + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, missingNode);
        assertEq(client.consecutiveFailedEpochs(), 1);

        // Repost, fail again.
        _postEpoch(epoch, _leaf(other, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode);
        vm.roll(block.number + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, missingNode);
        assertEq(client.consecutiveFailedEpochs(), 2);

        // Repost with a correct root this time -> finalizes cleanly -> next post resets counter.
        bytes32 leafOther = _leaf(other, 100, epoch);
        bytes32 leafMissing = _leaf(missingNode, 100, epoch);
        _postEpoch(epoch, _hashPair(leafOther, leafMissing));
        _rollPastFinalization();

        _postEpoch(epoch + 1, keccak256("epoch2root"));
        assertEq(client.consecutiveFailedEpochs(), 0);
    }

    // REENTRANCY ================================================================

    /// @notice Checks-effects-interactions ordering in `claimUnansweredChallenge`: a malicious
    ///         challenger that tries to re-enter the same call from its receive() hook must find
    ///         the challenge already resolved and the epoch already rolled back.
    function test_ClaimUnansweredChallenge_ReentrancyBlocked() public {
        address other = makeAddr("other");
        address missingNode = makeAddr("missingNode");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        MockReentrantChallenger attacker = new MockReentrantChallenger();
        attacker.setTarget(client, epoch, missingNode);
        vm.deal(address(attacker), CHALLENGE_BOND);
        attacker.challenge(CHALLENGE_BOND);

        vm.roll(block.number + RESPONSE_WINDOW + 1);
        attacker.claimUnanswered();

        assertTrue(attacker.reentered());
        assertFalse(attacker.reentrancySucceeded());
        assertEq(client.epochRoots(epoch), bytes32(0));
    }

    // FUZZ ======================================================================

    function testFuzz_RevertIf_ChallengeIneligible_UnregisteredNode(
        address missingNode
    ) public {
        vm.assume(missingNode != address(0));

        address other = makeAddr("other");
        vm.prank(other);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.NodeNotEligibleForDispute.selector, missingNode)
        );
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode);
    }

    function testFuzz_RevertIf_InsufficientChallengeBond(
        uint256 badBond
    ) public {
        vm.assume(badBond != CHALLENGE_BOND && badBond <= 1 ether);

        address other = makeAddr("other");
        address missingNode = makeAddr("missingNode");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        vm.deal(address(this), badBond);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.InsufficientBond.selector, badBond, CHALLENGE_BOND)
        );
        client.challengeOmission{ value: badBond }(epoch, missingNode);
    }

    // INTERNAL HELPERS ==========================================================

    function _deployFreshClient()
        internal
        returns (WeightedGovernanceClient freshClient, bytes32 freshContextUID)
    {
        vm.startPrank(admin);
        freshContextUID =
            core.registerContext(string(abi.encodePacked("nid.test.", block.number, gasleft())));

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            freshContextUID,
            settler,
            0,
            0,
            "EigenTrust",
            roles,
            weights
        );

        bytes32 adminRole = core.contextAdminRole(freshContextUID);
        address cloneAddr = factory.deployClient(
            freshContextUID, address(template), initData, bytes32(block.number)
        );
        freshClient = WeightedGovernanceClient(cloneAddr);
        core.grantRole(adminRole, address(freshClient));
        vm.stopPrank();
    }
}
