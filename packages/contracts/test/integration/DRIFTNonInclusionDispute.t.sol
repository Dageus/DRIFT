// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTClientFactory } from "../../src/client/DRIFTClientFactory.sol";
import { IDRIFTSettler } from "../../src/client/IDRIFTSettler.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { IDRIFTCore } from "../../src/core/IDRIFTCore.sol";
import { NodeStatus } from "../../src/policies/IPolicy.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { MockHostileRecipient } from "../mocks/MockHostileRecipient.sol";
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

        // A third-party challenger must itself be admitted at the epoch boundary it challenges,
        // so every identity these tests challenge *from* is registered here — before any epoch
        // exists, so registration always predates the boundary. Self-challenge needs none of
        // this; it is unconditional by design.
        _admitChallenger(address(this));
        _admitChallenger(makeAddr("challenger"));
        _admitChallenger(makeAddr("challengerA"));
        _admitChallenger(makeAddr("challengerB"));
        _admitChallenger(makeAddr("challengerC"));
    }

    function _admitChallenger(
        address who
    ) internal {
        vm.prank(who);
        core.registerNode(contextUID, "0x");
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
        return client.epochAnchorTimestamp() + client.epochLength() * epoch;
    }

    /// @dev Warps *forward* to the boundary only if we aren't already past it. A plain
    ///      `vm.warp(_boundary(epoch))` would move time backwards when reposting the same epoch
    ///      number after a rollback, which chain time cannot do — and the per-challenger cap
    ///      distinguishes rounds by comparing timestamps, so a backwards jump makes a repost look
    ///      like the same round as the challenge that rolled it back.
    function _warpToBoundary(
        uint256 epoch
    ) internal {
        uint256 boundary = _boundary(epoch);
        if (vm.getBlockTimestamp() < boundary) vm.warp(boundary);
    }

    function _postEpoch(
        uint256 epoch,
        bytes32 root
    ) internal {
        _warpToBoundary(epoch);
        bytes memory sig = _signEpochRoot(settlerPk, contextUID, epoch, root, address(client));
        vm.deal(client.trustedSettler(), client.trustedSettler().balance + 1000 ether);
        vm.startPrank(client.trustedSettler());
        client.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", sig);
        vm.stopPrank();
    }

    /// @dev As _postEpoch, but with an explicit settlement bond instead of the shared
    ///      SETTLEMENT_BOND constant -- for tests that need a settlement bond distinct from the
    ///      challenge bond.
    function _postEpochWithBond(
        uint256 epoch,
        bytes32 root,
        uint256 bondAmount
    ) internal {
        _warpToBoundary(epoch);
        bytes memory sig = _signEpochRoot(settlerPk, contextUID, epoch, root, address(client));
        vm.deal(client.trustedSettler(), client.trustedSettler().balance + 1000 ether);
        vm.startPrank(client.trustedSettler());
        client.postEpochRoot{ value: bondAmount }(epoch, root, "", sig);
        vm.stopPrank();
    }

    function _rollPastFinalization() internal {
        vm.warp(vm.getBlockTimestamp() + DISPUTE_WINDOW + RESPONSE_WINDOW + 1);
    }

    // CHALLENGE / RESPONSE ====================================================

    /// @notice A challenge against a node that genuinely has a leaf is defeated by a valid
    ///         inclusion proof; the challenger's bond is forfeited to the settler and the root
    ///         is untouched.
    function test_ChallengeDefeated_ValidResponse() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);

        uint256 epoch = 1;
        uint256 score = 100;
        _postEpoch(epoch, _leaf(nodeA, score, epoch));

        address challenger = makeAddr("challenger");
        vm.deal(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA, ROLE);

        assertEq(client.openChallengeCount(epoch), 1);

        uint256 settlerBalanceBefore = settler.balance;
        client.respondToChallenge(epoch, nodeA, ROLE, score, new bytes32[](0));

        assertEq(client.openChallengeCount(epoch), 0);
        assertEq(settler.balance, settlerBalanceBefore + CHALLENGE_BOND);
        assertEq(client.epochRoots(epoch), _leaf(nodeA, score, epoch));

        (,,, bool resolved) = client.challenges(epoch, nodeA, ROLE);
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
        vm.prank(admin);
        client.assignRole(missingNode, ROLE);
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);

        uint256 epoch = 1;
        uint256 score = 100;
        // Bad root: only nodeA's leaf, missingNode omitted entirely.
        _postEpoch(epoch, _leaf(nodeA, score, epoch));

        address challenger = makeAddr("challenger");
        vm.deal(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode, ROLE);

        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);

        uint256 challengerBalanceBefore = challenger.balance;
        client.claimUnansweredChallenge(epoch, missingNode, ROLE);

        // The forfeited settlement bond, plus the challenger's own challenge bond refunded.
        assertEq(challenger.balance, challengerBalanceBefore + SETTLEMENT_BOND + CHALLENGE_BOND);
        assertEq(client.epochRoots(epoch), bytes32(0));
        assertEq(client.currentEpoch(), 0);
        assertEq(client.epochPostedAtTimestamp(epoch), 0);
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
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);
        vm.prank(nodeB);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeB, ROLE);
        vm.prank(nodeC);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeC, ROLE);

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
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA, ROLE);
        vm.prank(challengerB);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeB, ROLE);
        vm.prank(challengerC);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeC, ROLE);

        assertEq(client.openChallengeCount(epoch), 3);

        // A's challenge is defeated early — unaffected by what happens to B and C later.
        client.respondToChallenge(epoch, nodeA, ROLE, score, _proofFor(leafB));
        assertEq(client.openChallengeCount(epoch), 2);

        // C's response window expires unanswered — rolls the epoch back.
        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        uint256 challengerCBalanceBefore = challengerC.balance;
        client.claimUnansweredChallenge(epoch, nodeC, ROLE);
        assertEq(challengerC.balance, challengerCBalanceBefore + SETTLEMENT_BOND + CHALLENGE_BOND);
        assertEq(client.epochRoots(epoch), bytes32(0));

        // B's still-open challenge is now moot: refund, no forfeiture either direction.
        uint256 challengerBBalanceBefore = challengerB.balance;
        client.reclaimMootChallenge(epoch, nodeB, ROLE);
        assertEq(challengerB.balance, challengerBBalanceBefore + CHALLENGE_BOND);
        assertEq(client.openChallengeCount(epoch), 0);
    }

    /// @notice Multiple moot challenges against the same rolled-back epoch can be refunded in one
    ///         transaction via reclaimMootChallenges, amortizing the fixed per-transaction
    ///         overhead that otherwise makes reclaiming a single bond uneconomical above some gas
    ///         price. Different challengers, refunded independently in one call.
    function test_ReclaimMootChallenges_BatchRefundsMultiple() public {
        address nodeA = makeAddr("nodeA");
        address nodeB = makeAddr("nodeB");
        address nodeC = makeAddr("nodeC"); // genuinely missing -> times out, rolls back
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);
        vm.prank(nodeB);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeB, ROLE);
        vm.prank(nodeC);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeC, ROLE);

        uint256 epoch = 1;
        uint256 score = 100;
        bytes32 leafA = _leaf(nodeA, score, epoch);
        bytes32 leafB = _leaf(nodeB, score, epoch);
        bytes32 root = _hashPair(leafA, leafB);
        _postEpoch(epoch, root);

        address challengerA = makeAddr("challengerA");
        address challengerB = makeAddr("challengerB");
        address challengerC = makeAddr("challengerC");
        vm.deal(challengerA, CHALLENGE_BOND);
        vm.deal(challengerB, CHALLENGE_BOND);
        vm.deal(challengerC, CHALLENGE_BOND);

        vm.prank(challengerA);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA, ROLE);
        vm.prank(challengerB);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeB, ROLE);
        vm.prank(challengerC);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeC, ROLE);

        // Neither A nor B is answered -- both are left open when C's timeout rolls back the epoch.
        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, nodeC, ROLE);
        assertEq(client.epochRoots(epoch), bytes32(0));

        uint256 balanceABefore = challengerA.balance;
        uint256 balanceBBefore = challengerB.balance;

        uint256[] memory epochs = new uint256[](2);
        address[] memory nodes = new address[](2);
        epochs[0] = epoch;
        epochs[1] = epoch;
        nodes[0] = nodeA;
        nodes[1] = nodeB;
        client.reclaimMootChallenges(epochs, nodes, _roles(nodes.length));

        assertEq(challengerA.balance, balanceABefore + CHALLENGE_BOND);
        assertEq(challengerB.balance, balanceBBefore + CHALLENGE_BOND);
        assertEq(client.openChallengeCount(epoch), 0);
    }

    function test_RevertIf_ReclaimMootChallenges_ArrayLengthMismatch() public {
        uint256[] memory epochs = new uint256[](2);
        address[] memory nodes = new address[](1);
        vm.expectRevert(WeightedGovernanceClient.ArrayLengthMismatch.selector);
        client.reclaimMootChallenges(epochs, nodes, _roles(nodes.length));
    }

    /// @notice A batch reverts entirely if any single entry isn't currently reclaimable -- no
    ///         partial application that could leave a caller thinking only one entry failed when
    ///         the whole call actually rolled back.
    function test_RevertIf_ReclaimMootChallenges_OneEntryNotReclaimable() public {
        address nodeA = makeAddr("nodeA");
        address nodeC = makeAddr("nodeC");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);
        vm.prank(nodeC);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeC, ROLE);

        uint256 epoch = 1;
        uint256 score = 100;
        _postEpoch(epoch, _leaf(nodeA, score, epoch));

        address challengerA = makeAddr("challengerA");
        address challengerC = makeAddr("challengerC");
        vm.deal(challengerA, CHALLENGE_BOND);
        vm.deal(challengerC, CHALLENGE_BOND);

        vm.prank(challengerA);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA, ROLE);
        vm.prank(challengerC);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeC, ROLE);

        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, nodeC, ROLE);

        // nodeA's challenge is moot and reclaimable; the second entry names a node never
        // challenged at all.
        address neverChallenged = makeAddr("neverChallenged");
        uint256[] memory epochs = new uint256[](2);
        address[] memory nodes = new address[](2);
        epochs[0] = epoch;
        nodes[0] = nodeA;
        epochs[1] = epoch;
        nodes[1] = neverChallenged;

        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.ChallengeNotFound.selector, epoch, neverChallenged, ROLE
            )
        );
        client.reclaimMootChallenges(epochs, nodes, _roles(nodes.length));
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

        vm.warp(vm.getBlockTimestamp() + 1); // strictly after the boundary timestamp

        address late = makeAddr("late");
        vm.prank(late);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(late, ROLE); // registers AFTER the boundary already passed

        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.NodeNotEligibleForDispute.selector, late)
        );
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, late, ROLE);
    }

    /// @notice A node banned *after* the boundary must still be disputable — banning it after the
    ///         fact must not let a colluding admin strip a legitimately-omitted node's standing.
    function test_ChallengeEligible_BannedAfterBoundary() public {
        address victim = makeAddr("victim");
        vm.prank(victim);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(victim, ROLE);

        uint256 epoch = 1;
        // victim omitted from the root entirely.
        address other = makeAddr("other");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        _postEpoch(epoch, _leaf(other, 100, epoch));
        vm.warp(vm.getBlockTimestamp() + 1); // strictly after the boundary timestamp

        vm.prank(admin);
        core.setNodeStatus(contextUID, victim, NodeStatus.BANNED);

        // Must NOT revert: victim was registered before the boundary and only banned after it.
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, victim, ROLE);
        assertEq(client.openChallengeCount(epoch), 1);
    }

    // WINDOW BOUNDARIES ========================================================

    function test_RevertIf_ChallengeWindowClosed() public {
        address missingNode = makeAddr("missingNode");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(missingNode, ROLE);

        address other = makeAddr("other");
        vm.prank(other);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        vm.warp(vm.getBlockTimestamp() + DISPUTE_WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.DisputeWindowClosed.selector, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode, ROLE);
    }

    function test_RevertIf_ClaimUnansweredChallenge_ResponseWindowStillOpen() public {
        address missingNode = makeAddr("missingNode");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(missingNode, ROLE);
        address other = makeAddr("other");
        vm.prank(other);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode, ROLE);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.ResponseWindowStillOpen.selector, epoch, missingNode, ROLE
            )
        );
        client.claimUnansweredChallenge(epoch, missingNode, ROLE);
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

        vm.warp(freshClient.epochAnchorTimestamp() + freshClient.epochLength() * epoch);
        vm.deal(freshClient.trustedSettler(), freshClient.trustedSettler().balance + 1000 ether);
        vm.startPrank(freshClient.trustedSettler());
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.WindowsExceedEpochLength.selector, uint256(3), uint256(2), uint256(2)
            )
        );
        freshClient.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", sig);
        vm.stopPrank();
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

        vm.warp(freshClient.epochAnchorTimestamp() + freshClient.epochLength() * epoch);
        vm.deal(freshClient.trustedSettler(), freshClient.trustedSettler().balance + 1000 ether);
        vm.startPrank(freshClient.trustedSettler());
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.BondBelowFloor.selector, 0, freshClient.MIN_SETTLEMENT_BOND()
            )
        );
        freshClient.postEpochRoot(epoch, root, "", sig);
        vm.stopPrank();
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
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);

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
        vm.prank(admin);
        client.assignRole(missingNode, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode, ROLE);
        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, missingNode, ROLE);
        assertEq(client.consecutiveFailedEpochs(), 1);

        // Repost, fail again.
        _postEpoch(epoch, _leaf(other, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode, ROLE);
        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, missingNode, ROLE);
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
        vm.prank(admin);
        client.assignRole(missingNode, ROLE);

        // Deployed and admitted before the boundary: a third-party challenger must itself be
        // eligible at the epoch boundary, so the mock cannot be created after the root is posted.
        MockReentrantChallenger attacker = new MockReentrantChallenger();
        vm.prank(address(attacker));
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        attacker.setTarget(client, epoch, missingNode, ROLE);
        vm.deal(address(attacker), CHALLENGE_BOND);
        attacker.challenge(CHALLENGE_BOND);

        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        attacker.claimUnanswered();

        assertTrue(attacker.reentered());
        assertFalse(attacker.reentrancySucceeded());
        assertEq(client.epochRoots(epoch), bytes32(0));
    }

    // STANDING AND DYNAMIC PRICING ==============================================

    /// @notice The soundness case for unconditional self-challenge: a node admitted at the
    ///         boundary and omitted in that same epoch has no leaf, hence no reputation and no
    ///         prior inclusion proof, and may still challenge its own omission. Gating this on
    ///         anything derived from settled state would let a settler strip a node's standing to
    ///         contest an omission by committing that very omission.
    function test_SelfChallenge_UnreputedFirstEpochNode_Succeeds() public {
        address other = makeAddr("other");
        address victim = makeAddr("victim");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(victim);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(victim, ROLE);

        uint256 epoch = 1;
        // Root contains only `other` — victim is omitted in the first epoch it was ever admitted.
        _postEpoch(epoch, _leaf(other, 100, epoch));

        vm.deal(victim, CHALLENGE_BOND);
        vm.prank(victim);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, victim, ROLE);

        assertEq(client.openChallengeCount(epoch), 1);
    }

    /// @notice Self-challenge ignores the third-party age gate entirely, even when that gate is
    ///         set high enough to exclude every existing node.
    function test_SelfChallenge_IgnoresThirdPartyAgeGate() public {
        vm.prank(admin);
        client.setThirdPartyChallengeMinAge(365 days);

        address other = makeAddr("other");
        address victim = makeAddr("victim");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(victim);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(victim, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        vm.deal(victim, CHALLENGE_BOND);
        vm.prank(victim);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, victim, ROLE);

        assertEq(client.openChallengeCount(epoch), 1);
    }

    function test_RevertIf_ThirdPartyChallenger_NotAdmitted() public {
        address other = makeAddr("other");
        address missingNode = makeAddr("missingNode");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(missingNode, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        address outsider = makeAddr("outsider"); // never registered
        vm.deal(outsider, CHALLENGE_BOND);
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.ChallengerNotAdmitted.selector, outsider)
        );
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode, ROLE);
    }

    function test_RevertIf_ThirdPartyChallenger_BelowMinAge() public {
        vm.prank(admin);
        client.setThirdPartyChallengeMinAge(365 days);

        address other = makeAddr("other");
        address missingNode = makeAddr("missingNode");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(missingNode, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        // challengerA is admitted, but nowhere near 365 days before the boundary.
        address challengerA = makeAddr("challengerA");
        vm.deal(challengerA, CHALLENGE_BOND);
        vm.prank(challengerA);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.ThirdPartyChallengeNotPermitted.selector, challengerA, missingNode
            )
        );
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode, ROLE);
    }

    function test_RevertIf_SameChallengerTwiceInOneEpoch() public {
        address other = makeAddr("other");
        address nodeB = makeAddr("nodeB");
        address nodeC = makeAddr("nodeC");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(nodeB);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeB, ROLE);
        vm.prank(nodeC);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeC, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        address challengerA = makeAddr("challengerA");
        vm.deal(challengerA, CHALLENGE_BOND * 2);
        vm.prank(challengerA);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeB, ROLE);

        vm.prank(challengerA);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.AlreadyChallengedThisEpoch.selector, epoch, challengerA
            )
        );
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeC, ROLE);
    }

    /// @notice The per-challenger cap must be scoped to the epoch *round*, not the epoch number.
    ///         A challenger who was correct — whose challenge rolled the epoch back — has to be
    ///         able to challenge the reposted root if it still omits the same node. A cap that
    ///         never reset would let a settler absorb one rollback and then repost the identical
    ///         omission unchallengeable by its victim.
    function test_ChallengerMayChallengeAgain_AfterRollbackAndRepost() public {
        address other = makeAddr("other");
        address victim = makeAddr("victim");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(victim);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(victim, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        vm.deal(victim, CHALLENGE_BOND * 2);
        vm.prank(victim);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, victim, ROLE);

        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, victim, ROLE);
        assertEq(client.epochRoots(epoch), bytes32(0));

        // Settler reposts the same epoch number, still omitting the victim.
        _postEpoch(epoch, _leaf(other, 100, epoch));

        vm.prank(victim);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, victim, ROLE);
        assertEq(client.openChallengeCount(epoch), 1);
    }

    function test_RequiredChallengeBond_TracksBasefee() public {
        vm.prank(admin);
        client.setResponseGasEstimate(80_000);

        vm.fee(0);
        assertEq(client.requiredChallengeBond(), CHALLENGE_BOND, "floor applies at zero basefee");

        // 80,000 gas * 100 gwei * 1.2 margin = 0.0096 ETH, well above the 0.01 ether floor? No —
        // below it, so the floor still wins. Use a basefee high enough to clear the floor.
        vm.fee(100 gwei);
        assertEq(client.requiredChallengeBond(), CHALLENGE_BOND, "floor still dominates");

        vm.fee(200 gwei);
        // 80,000 * 200 gwei = 0.016 ETH; * 1.2 = 0.0192 ETH > 0.01 ETH floor.
        assertEq(client.requiredChallengeBond(), 0.0192 ether, "response cost dominates");
    }

    function test_ChallengeOmission_RefundsBondExcess() public {
        vm.prank(admin);
        client.setResponseGasEstimate(80_000);
        vm.fee(200 gwei);

        address other = makeAddr("other");
        address victim = makeAddr("victim");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(victim);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(victim, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        uint256 required = client.requiredChallengeBond();
        uint256 overpay = required + 1 ether;
        vm.deal(victim, overpay);
        vm.prank(victim);
        client.challengeOmission{ value: overpay }(epoch, victim, ROLE);

        // Only the required amount is at stake; the pad against basefee movement comes back.
        assertEq(victim.balance, 1 ether);
        (, uint256 bond,,) = client.challenges(epoch, victim, ROLE);
        assertEq(bond, required);
    }

    function test_RevertIf_ChallengeBondBelowDynamicRequirement() public {
        vm.prank(admin);
        client.setResponseGasEstimate(80_000);
        vm.fee(200 gwei);

        address other = makeAddr("other");
        address victim = makeAddr("victim");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(victim);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(victim, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        uint256 required = client.requiredChallengeBond();
        vm.deal(victim, required);
        vm.prank(victim);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.InsufficientBond.selector, required - 1, required)
        );
        client.challengeOmission{ value: required - 1 }(epoch, victim, ROLE);
    }

    function test_RevertIf_ResponseGasEstimateAboveCap() public {
        uint256 cap = client.MAX_RESPONSE_GAS_ESTIMATE();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.ResponseGasEstimateTooHigh.selector, cap + 1, cap)
        );
        client.setResponseGasEstimate(cap + 1);
    }

    // STUCK BOND FIX ============================================================

    /// @notice claimUnansweredChallenge must refund the winning challenger's own challenge bond
    ///         alongside the forfeited settlement bond. Uses distinct bond amounts specifically so
    ///         a regression that pays only one of the two (in either direction) cannot pass by
    ///         coincidence the way it could with the shared suite's equal SETTLEMENT_BOND ==
    ///         CHALLENGE_BOND.
    function test_ClaimUnansweredChallenge_RefundsChallengerOwnBond() public {
        uint256 distinctSettlementBond = 0.02 ether;
        uint256 distinctChallengeBond = 0.005 ether;
        vm.startPrank(admin);
        client.setSettlementBond(distinctSettlementBond);
        client.setChallengeBond(distinctChallengeBond);
        vm.stopPrank();

        address missingNode = makeAddr("missingNode");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(missingNode, ROLE);
        address other = makeAddr("other");
        vm.prank(other);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpochWithBond(epoch, _leaf(other, 100, epoch), distinctSettlementBond);

        address challenger = makeAddr("challenger");
        vm.deal(challenger, distinctChallengeBond);
        vm.prank(challenger);
        client.challengeOmission{ value: distinctChallengeBond }(epoch, missingNode, ROLE);

        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);

        uint256 challengerBalanceBefore = challenger.balance;
        client.claimUnansweredChallenge(epoch, missingNode, ROLE);

        assertEq(
            challenger.balance,
            challengerBalanceBefore + distinctSettlementBond + distinctChallengeBond
        );

        // The now-refunded challenge bond has no remaining exit path -- confirm it can't be
        // double-paid via reclaimMootChallenge.
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.ChallengeAlreadyResolved.selector, epoch, missingNode, ROLE
            )
        );
        client.reclaimMootChallenge(epoch, missingNode, ROLE);
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
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode, ROLE);
    }

    /// @dev Strictly *below* the requirement, not merely different from it: the bond check is
    ///      `>=`, because the required amount depends on the basefee of the block the call lands
    ///      in and a caller must be able to pad against that. Overpayment is refunded, not
    ///      rejected — see test_ChallengeOmission_RefundsBondExcess.
    function testFuzz_RevertIf_InsufficientChallengeBond(
        uint256 badBond
    ) public {
        vm.assume(badBond < CHALLENGE_BOND);

        address other = makeAddr("other");
        address missingNode = makeAddr("missingNode");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(missingNode, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        vm.deal(address(this), badBond);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.InsufficientBond.selector, badBond, CHALLENGE_BOND)
        );
        client.challengeOmission{ value: badBond }(epoch, missingNode, ROLE);
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

    // CHALLENGE / RESPONSE — GUARD BRANCHES ===================================

    function test_RevertIf_ChallengeAlreadyOpen() public {
        address other = makeAddr("other");
        address missingNode = makeAddr("missingNode");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(missingNode, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode, ROLE);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.ChallengeAlreadyOpen.selector, epoch, missingNode, ROLE
            )
        );
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode, ROLE);
    }

    function test_RevertIf_RespondToChallenge_ChallengeNotFound() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));

        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.ChallengeNotFound.selector, epoch, nodeA, ROLE)
        );
        client.respondToChallenge(epoch, nodeA, ROLE, 100, new bytes32[](0));
    }

    function test_RevertIf_RespondToChallenge_ChallengeAlreadyResolved() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA, ROLE);
        client.respondToChallenge(epoch, nodeA, ROLE, 100, new bytes32[](0));

        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.ChallengeAlreadyResolved.selector, epoch, nodeA, ROLE
            )
        );
        client.respondToChallenge(epoch, nodeA, ROLE, 100, new bytes32[](0));
    }

    /// @notice A challenge left open against a node with a genuine leaf becomes unanswerable once
    ///         a *different*, unrelated challenge in the same epoch times out and rolls the root
    ///         back — respondToChallenge must recognize the epoch is already gone rather than
    ///         verifying a proof against a root that no longer applies.
    function test_RevertIf_RespondToChallenge_EpochAlreadyInvalidated() public {
        address nodeA = makeAddr("nodeA"); // has a leaf, challenge left open
        address nodeC = makeAddr("nodeC"); // genuinely missing, times out
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);
        vm.prank(nodeC);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeC, ROLE);

        uint256 epoch = 1;
        bytes32 leafA = _leaf(nodeA, 100, epoch);
        _postEpoch(epoch, leafA);

        // Distinct challengers: each is capped at one challenge per epoch round.
        address challengerA = makeAddr("challengerA");
        address challengerB = makeAddr("challengerB");
        vm.deal(challengerA, CHALLENGE_BOND);
        vm.deal(challengerB, CHALLENGE_BOND);
        vm.prank(challengerA);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA, ROLE);
        vm.prank(challengerB);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeC, ROLE);

        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, nodeC, ROLE);
        assertEq(client.epochRoots(epoch), bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.EpochAlreadyInvalidated.selector, epoch)
        );
        client.respondToChallenge(epoch, nodeA, ROLE, 100, new bytes32[](0));
    }

    function test_RevertIf_RespondToChallenge_ResponseWindowClosed() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA, ROLE);

        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.ResponseWindowClosed.selector, epoch, nodeA, ROLE)
        );
        client.respondToChallenge(epoch, nodeA, ROLE, 100, new bytes32[](0));
    }

    function test_RevertIf_RespondToChallenge_InvalidMerkleProof() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA, ROLE);

        // Wrong score claimed for nodeA's leaf — proof (none) can't verify against a different leaf.
        vm.expectRevert(IDRIFTSettler.InvalidMerkleProof.selector);
        client.respondToChallenge(epoch, nodeA, ROLE, 999, new bytes32[](0));
    }

    function test_RevertIf_ClaimUnansweredChallenge_ChallengeNotFound() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.ChallengeNotFound.selector, uint256(1), makeAddr("nobody"), ROLE
            )
        );
        client.claimUnansweredChallenge(1, makeAddr("nobody"), ROLE);
    }

    function test_RevertIf_ClaimUnansweredChallenge_ChallengeAlreadyResolved() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA, ROLE);
        client.respondToChallenge(epoch, nodeA, ROLE, 100, new bytes32[](0));

        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.ChallengeAlreadyResolved.selector, epoch, nodeA, ROLE
            )
        );
        client.claimUnansweredChallenge(epoch, nodeA, ROLE);
    }

    /// @notice Mirrors test_RevertIf_RespondToChallenge_EpochAlreadyInvalidated for the
    ///         claimUnansweredChallenge path: a second still-open challenge cannot be claimed
    ///         unanswered a second time against an epoch already rolled back by a different one.
    function test_RevertIf_ClaimUnansweredChallenge_EpochAlreadyInvalidated() public {
        address nodeA = makeAddr("nodeA");
        address nodeC = makeAddr("nodeC");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(nodeC);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeC, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));

        // Both genuinely missing from the (single-leaf) root above except nodeA itself; challenge
        // both, let nodeC's time out first to roll the epoch back, then nodeA's is left dangling.
        address nodeB = makeAddr("nodeB");
        vm.prank(nodeB);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeB, ROLE);

        // Distinct challengers: each is capped at one challenge per epoch round.
        address challengerA = makeAddr("challengerA");
        address challengerB = makeAddr("challengerB");
        vm.deal(challengerA, CHALLENGE_BOND);
        vm.deal(challengerB, CHALLENGE_BOND);
        vm.prank(challengerA);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeB, ROLE);
        vm.prank(challengerB);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeC, ROLE);

        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, nodeC, ROLE);

        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.EpochAlreadyInvalidated.selector, epoch)
        );
        client.claimUnansweredChallenge(epoch, nodeB, ROLE);
    }

    function test_RevertIf_ReclaimMootChallenge_ChallengeNotFound() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.ChallengeNotFound.selector, uint256(1), makeAddr("nobody"), ROLE
            )
        );
        client.reclaimMootChallenge(1, makeAddr("nobody"), ROLE);
    }

    function test_RevertIf_ReclaimMootChallenge_ChallengeAlreadyResolved() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA, ROLE);
        client.respondToChallenge(epoch, nodeA, ROLE, 100, new bytes32[](0));

        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTSettler.ChallengeAlreadyResolved.selector, epoch, nodeA, ROLE
            )
        );
        client.reclaimMootChallenge(epoch, nodeA, ROLE);
    }

    /// @notice reclaimMootChallenge is only for a challenge whose epoch was invalidated by a
    ///         *different* resolution — calling it while the root is still live (nothing moot
    ///         about it) must revert, not silently refund.
    function test_RevertIf_ReclaimMootChallenge_EpochNotInvalidated() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(nodeA, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA, ROLE);

        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.EpochNotInvalidated.selector, epoch));
        client.reclaimMootChallenge(epoch, nodeA, ROLE);
    }

    /// @notice The ineligibility half of _disputeEligible's ban check: a node banned *at or before*
    ///         the boundary was never legitimately part of A_c^E at settlement time, so it cannot
    ///         be the subject of a dispute — complements test_ChallengeEligible_BannedAfterBoundary.
    function test_RevertIf_ChallengeIneligible_BannedBeforeBoundary() public {
        address victim = makeAddr("victim");
        vm.prank(victim);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(victim, ROLE);
        vm.prank(admin);
        core.setNodeStatus(contextUID, victim, NodeStatus.BANNED);

        address other = makeAddr("other");
        vm.prank(other);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));

        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.NodeNotEligibleForDispute.selector, victim)
        );
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, victim, ROLE);
    }

    // FINALIZATION TIMING ======================================================

    /// @notice An epoch with zero challenges ever raised finalizes as soon as the dispute window
    ///         alone elapses — it must not also wait out the response window, which would be pure
    ///         dead time: once disputeWindow has passed, challengeOmission's own window check
    ///         permanently forecloses any new challenge, so openChallengeCount == 0 at that moment
    ///         proves nothing can ever become pending again.
    function test_Finalizes_AtDisputeWindowAlone_WhenNoChallengeRaised() public {
        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));

        // Strictly past DISPUTE_WINDOW alone, strictly before DISPUTE_WINDOW + RESPONSE_WINDOW —
        // the old unconditional bound would still be pending here.
        vm.warp(vm.getBlockTimestamp() + DISPUTE_WINDOW + 1);

        uint256 settlerBalanceBefore = settler.balance;
        client.withdrawSettlementBond(epoch);
        assertEq(settler.balance, settlerBalanceBefore + SETTLEMENT_BOND);
    }

    /// @notice The tightened bound must not skip the case it exists to protect: an epoch with a
    ///         still-open challenge stays unfinalized past disputeWindow alone, exactly as before.
    function test_RevertIf_StillPendingAtDisputeWindowAlone_WithOpenChallenge() public {
        address nodeA = makeAddr("nodeA");
        address missingNode = makeAddr("missingNode");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(missingNode, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode, ROLE);

        vm.warp(vm.getBlockTimestamp() + DISPUTE_WINDOW + 1);

        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.EpochNotYetFinalized.selector, epoch));
        client.withdrawSettlementBond(epoch);
    }

    /// @dev A roles array of length `n`, all `ROLE`, for the batched reclaim.
    function _roles(
        uint256 n
    ) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            r[i] = ROLE;
        }
    }

    // PAIR-LEVEL ELIGIBILITY ==================================================

    bytes32 constant ROLE_B = keccak256("ROLE_B");

    function _leafFor(
        address node,
        bytes32 role,
        uint256 score,
        uint256 epoch
    ) internal view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(contextUID, node, role, score, epoch))));
    }

    /// @notice Regression for a griefing bug. A registered node holding no role has no leaf in a
    ///         correct root, so an unanswerable challenge against it used to delete the root and
    ///         pay the honest settler's bond to the challenger. It must be rejected up front.
    function test_RevertIf_Challenge_RolelessNode() public {
        address honest = makeAddr("honestNode");
        address roleless = makeAddr("rolelessNode");
        vm.prank(honest);
        core.registerNode(contextUID, "0x");
        vm.prank(roleless);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(honest, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(honest, 100, epoch));

        vm.deal(roleless, CHALLENGE_BOND);
        vm.prank(roleless);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.RoleNotHeldAtBoundary.selector, roleless, ROLE)
        );
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, roleless, ROLE);
    }

    /// @notice A role assigned after the boundary did not exist when the root was computed.
    function test_RevertIf_Challenge_RoleAssignedAfterBoundary() public {
        address node = makeAddr("lateRole");
        vm.prank(node);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, keccak256("root-without-node"));
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(admin);
        client.assignRole(node, ROLE);

        vm.deal(node, CHALLENGE_BOND);
        vm.prank(node);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.RoleNotHeldAtBoundary.selector, node, ROLE)
        );
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, node, ROLE);
    }

    /// @notice A role revoked before the boundary no longer existed when the root was computed.
    function test_RevertIf_Challenge_RoleRevokedBeforeBoundary() public {
        address node = makeAddr("revokedEarly");
        vm.prank(node);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(node, ROLE);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(admin);
        client.revokeRole(node, ROLE);

        uint256 epoch = 1;
        _postEpoch(epoch, keccak256("root-without-node"));

        vm.deal(node, CHALLENGE_BOND);
        vm.prank(node);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.RoleNotHeldAtBoundary.selector, node, ROLE)
        );
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, node, ROLE);
    }

    /// @notice Revoking a role after the boundary does not excuse its omission: the pair existed
    ///         when the root was computed, so the omission stays contestable.
    function test_Challenge_RoleRevokedAfterBoundary_StillContestable() public {
        address node = makeAddr("revokedLate");
        address other = makeAddr("otherNode");
        vm.prank(node);
        core.registerNode(contextUID, "0x");
        vm.prank(other);
        core.registerNode(contextUID, "0x");
        vm.startPrank(admin);
        client.assignRole(node, ROLE);
        client.assignRole(other, ROLE);
        vm.stopPrank();

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(other, 100, epoch));
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(admin);
        client.revokeRole(node, ROLE);

        vm.deal(node, CHALLENGE_BOND);
        vm.prank(node);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, node, ROLE);
        assertEq(client.openChallengeCount(epoch), 1);
    }

    /// @notice Completeness is per (node, role) pair. Including one of a node's roles does not cover
    ///         another it also held: a leaf for ROLE cannot answer a challenge over ROLE_B, so
    ///         omitting ROLE_B is contestable even though the node appears in the root.
    function test_PerRoleOmission_IsContestable() public {
        address node = makeAddr("twoRoles");
        vm.prank(node);
        core.registerNode(contextUID, "0x");
        vm.startPrank(admin);
        client.assignRole(node, ROLE);
        client.assignRole(node, ROLE_B);
        vm.stopPrank();

        uint256 epoch = 1;
        _postEpoch(epoch, _leafFor(node, ROLE, 100, epoch));

        address challenger = makeAddr("challengerA");
        vm.deal(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, node, ROLE_B);

        // The ROLE leaf is genuinely in the root, but it is not a leaf for the challenged pair.
        vm.expectRevert(IDRIFTSettler.InvalidMerkleProof.selector);
        client.respondToChallenge(epoch, node, ROLE_B, 100, new bytes32[](0));
        // Nor does proving the ROLE pair resolve a challenge over ROLE_B.
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTSettler.ChallengeNotFound.selector, epoch, node, ROLE)
        );
        client.respondToChallenge(epoch, node, ROLE, 100, new bytes32[](0));

        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, node, ROLE_B);
        assertEq(client.epochRoots(epoch), bytes32(0));
    }

    // ROLLBACK REPLAY AND REFUSED PAYOUTS ====================================

    /// @dev Posts a root omitting `missing`, has `challenger` (or a hostile contract) contest it,
    ///      and lets the response window lapse. Returns the rejected root and its signature.
    function _omitAndChallenge(
        uint256 epoch,
        address present,
        address missing,
        address challenger
    ) internal returns (bytes32 badRoot, bytes memory badSig) {
        badRoot = _leaf(present, 100, epoch);
        badSig = _signEpochRoot(settlerPk, contextUID, epoch, badRoot, address(client));
        _postEpoch(epoch, badRoot);
        vm.deal(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missing, ROLE);
    }

    function _twoAdmittedNodes() internal returns (address present, address missing) {
        present = makeAddr("presentNode");
        missing = makeAddr("missingNode");
        vm.prank(present);
        core.registerNode(contextUID, "0x");
        vm.prank(missing);
        core.registerNode(contextUID, "0x");
        vm.startPrank(admin);
        client.assignRole(present, ROLE);
        client.assignRole(missing, ROLE);
        vm.stopPrank();
    }

    /// @notice A rolled-back root keeps a valid settler signature. Before posting was restricted to
    ///         the settler, anyone holding the bond could re-post it and block the correction.
    function test_RevertIf_RolledBackRoot_ReplayedByThirdParty() public {
        (address present, address missing) = _twoAdmittedNodes();
        uint256 epoch = 1;
        (bytes32 badRoot, bytes memory badSig) =
            _omitAndChallenge(epoch, present, missing, makeAddr("challenger"));
        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, missing, ROLE);
        assertEq(client.epochRoots(epoch), bytes32(0));

        address replayer = makeAddr("replayer");
        vm.deal(replayer, SETTLEMENT_BOND);
        vm.prank(replayer);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.NotTrustedSettler.selector, replayer));
        client.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, badRoot, "", badSig);

        // The settler's correction still goes through.
        bytes32 corrected = _hashPair(_leaf(present, 100, epoch), _leaf(missing, 100, epoch));
        _postEpoch(epoch, corrected);
        assertEq(client.epochRoots(epoch), corrected);
    }

    /// @notice A challenger that refuses its winnings cannot stall the rollback: the payout is
    ///         credited, the epoch rolls back, and the challenger can collect later.
    function test_UnansweredClaim_CreditsRefusingChallenger() public {
        MockHostileRecipient.Mode[3] memory modes = [
            MockHostileRecipient.Mode.Reject,
            MockHostileRecipient.Mode.BurnGas,
            MockHostileRecipient.Mode.ReturnBomb
        ];
        for (uint256 i = 0; i < modes.length; i++) {
            uint256 snap = vm.snapshotState();
            (address present, address missing) = _twoAdmittedNodes();
            MockHostileRecipient hostile = new MockHostileRecipient(client);
            hostile.register(IDRIFTCore(address(core)), contextUID);
            hostile.setMode(modes[i]);

            uint256 epoch = 1;
            _omitAndChallenge(epoch, present, missing, address(hostile));
            vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);

            vm.expectEmit(address(client));
            emit IDRIFTSettler.PayoutDeferred(address(hostile), SETTLEMENT_BOND + CHALLENGE_BOND);
            // Calibrated limit: the worst hostile mode needs ~115k here. An uncapped call would let
            // BurnGas starve the credit, and copying ReturnBomb's revert data costs ~35k more, so
            // either regression fails this call.
            client.claimUnansweredChallenge{ gas: 120_000 }(epoch, missing, ROLE);

            assertEq(client.epochRoots(epoch), bytes32(0), "rolled back");
            assertEq(client.openChallengeCount(epoch), 0);
            assertEq(address(hostile).balance, 0);
            assertEq(client.pendingPayouts(address(hostile)), SETTLEMENT_BOND + CHALLENGE_BOND);

            hostile.setMode(MockHostileRecipient.Mode.Accept);
            hostile.withdraw();
            assertEq(address(hostile).balance, SETTLEMENT_BOND + CHALLENGE_BOND);
            assertEq(client.pendingPayouts(address(hostile)), 0);
            vm.revertToState(snap);
        }
    }

    /// @notice A moot challenge whose owner refuses the refund used to keep openChallengeCount
    ///         above zero forever, so the reposted epoch could never finalize.
    function test_MootReclaim_CreditsRefusingChallenger_RepostFinalizes() public {
        (address present, address missing) = _twoAdmittedNodes();
        MockHostileRecipient hostile = new MockHostileRecipient(client);
        hostile.register(IDRIFTCore(address(core)), contextUID);

        uint256 epoch = 1;
        _omitAndChallenge(epoch, present, missing, makeAddr("challenger"));
        // The hostile contract contests the present node too, then refuses every payment.
        vm.deal(address(hostile), CHALLENGE_BOND);
        hostile.challenge{ value: CHALLENGE_BOND }(epoch, present, ROLE);
        hostile.setMode(MockHostileRecipient.Mode.Reject);

        vm.warp(vm.getBlockTimestamp() + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, missing, ROLE);
        client.reclaimMootChallenge(epoch, present, ROLE);
        assertEq(client.openChallengeCount(epoch), 0);
        assertEq(client.pendingPayouts(address(hostile)), CHALLENGE_BOND);

        bytes32 corrected = _hashPair(_leaf(present, 100, epoch), _leaf(missing, 100, epoch));
        _postEpoch(epoch, corrected);
        _rollPastFinalization();
        client.withdrawSettlementBond(epoch); // reverts unless the epoch finalized
    }

    function test_RevertIf_WithdrawPendingPayout_NothingOwed() public {
        address nobody = makeAddr("nobody");
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.NoPendingPayout.selector, nobody));
        client.withdrawPendingPayout();
    }
}
