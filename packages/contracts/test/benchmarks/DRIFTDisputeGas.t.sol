// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTClientFactory } from "../../src/client/DRIFTClientFactory.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { DRIFTTestHelper } from "../utils/DRIFTTestHelper.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title DRIFTDisputeGasTest
/// @notice Gas benchmarks for the B1 non-inclusion dispute path (challenge / response /
///         resolution) and its one-time admin configuration calls. Isolated per-operation costs
///         via `vm.startSnapshotGas`/`stopSnapshotGas`, matching the methodology used for
///         claim/vote/postEpochRoot in DRIFTMerkleGas.t.sol and DRIFTVoteGas.t.sol — NOT the
///         whole-test-function totals `forge snapshot` records in `.gas-snapshot`.
contract DRIFTDisputeGasTest is DRIFTTestHelper {
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
        contextUID = core.registerContext("dispute.gas.test");

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

    function _postEpoch(
        uint256 epoch,
        bytes32 root
    ) internal {
        vm.warp(client.epochAnchorTimestamp() + client.epochLength() * epoch);
        bytes memory sig = _signEpochRoot(settlerPk, contextUID, epoch, root, address(client));
        client.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", sig);
    }

    // ONE-TIME CONFIGURATION ===================================================

    function test_Gas_SetDisputeWindow() public {
        vm.prank(admin);
        vm.startSnapshotGas("SetDisputeWindow");
        client.setDisputeWindow(DISPUTE_WINDOW);
        vm.stopSnapshotGas();
    }

    function test_Gas_SetResponseWindow() public {
        vm.prank(admin);
        vm.startSnapshotGas("SetResponseWindow");
        client.setResponseWindow(RESPONSE_WINDOW);
        vm.stopSnapshotGas();
    }

    function test_Gas_SetSettlementBond() public {
        vm.prank(admin);
        vm.startSnapshotGas("SetSettlementBond");
        client.setSettlementBond(SETTLEMENT_BOND);
        vm.stopSnapshotGas();
    }

    function test_Gas_SetChallengeBond() public {
        vm.prank(admin);
        vm.startSnapshotGas("SetChallengeBond");
        client.setChallengeBond(CHALLENGE_BOND);
        vm.stopSnapshotGas();
    }

    // DISPUTE PATH ==============================================================

    /// @notice Cost for a challenger to open a non-inclusion challenge against an eligible node.
    function test_Gas_ChallengeOmission() public {
        vm.startPrank(admin);
        client.setDisputeWindow(DISPUTE_WINDOW);
        client.setResponseWindow(RESPONSE_WINDOW);
        client.setSettlementBond(SETTLEMENT_BOND);
        client.setChallengeBond(CHALLENGE_BOND);
        vm.stopPrank();

        address nodeA = makeAddr("nodeA");
        address missingNode = makeAddr("missingNode");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));

        address challenger = makeAddr("challenger");
        vm.deal(challenger, CHALLENGE_BOND);

        vm.prank(challenger);
        vm.startSnapshotGas("ChallengeOmission");
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode);
        vm.stopSnapshotGas();
    }

    /// @notice Cost for the settler to defeat a challenge with a valid inclusion proof
    ///         (proof depth 1 — the cheapest non-degenerate case; scales like claimReputation's
    ///         Merkle-verification cost per additional depth).
    function test_Gas_RespondToChallenge_Depth1() public {
        vm.startPrank(admin);
        client.setDisputeWindow(DISPUTE_WINDOW);
        client.setResponseWindow(RESPONSE_WINDOW);
        client.setSettlementBond(SETTLEMENT_BOND);
        client.setChallengeBond(CHALLENGE_BOND);
        vm.stopPrank();

        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 score = 100;
        bytes32 leafA = _leaf(nodeA, score, epoch);
        bytes32 sibling = keccak256("sibling");
        bytes32 root = leafA < sibling
            ? keccak256(abi.encodePacked(leafA, sibling))
            : keccak256(abi.encodePacked(sibling, leafA));
        _postEpoch(epoch, root);

        address challenger = makeAddr("challenger");
        vm.deal(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeA);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;

        vm.startSnapshotGas("RespondToChallenge_Depth1");
        client.respondToChallenge(epoch, nodeA, ROLE, score, proof);
        vm.stopSnapshotGas();
    }

    /// @notice Cost to execute a won-by-timeout challenge: rolls the epoch back and pays out the
    ///         settler's forfeited bond to the challenger.
    function test_Gas_ClaimUnansweredChallenge() public {
        vm.startPrank(admin);
        client.setDisputeWindow(DISPUTE_WINDOW);
        client.setResponseWindow(RESPONSE_WINDOW);
        client.setSettlementBond(SETTLEMENT_BOND);
        client.setChallengeBond(CHALLENGE_BOND);
        vm.stopPrank();

        address nodeA = makeAddr("nodeA");
        address missingNode = makeAddr("missingNode");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));

        address challenger = makeAddr("challenger");
        vm.deal(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode);

        vm.warp(block.timestamp + RESPONSE_WINDOW + 1);

        vm.startSnapshotGas("ClaimUnansweredChallenge");
        client.claimUnansweredChallenge(epoch, missingNode);
        vm.stopSnapshotGas();
    }

    /// @notice Cost to reclaim a challenger's bond once their challenge became moot (epoch was
    ///         already rolled back by a different concurrent challenge).
    function test_Gas_ReclaimMootChallenge() public {
        vm.startPrank(admin);
        client.setDisputeWindow(DISPUTE_WINDOW);
        client.setResponseWindow(RESPONSE_WINDOW);
        client.setSettlementBond(SETTLEMENT_BOND);
        client.setChallengeBond(CHALLENGE_BOND);
        vm.stopPrank();

        address nodeB = makeAddr("nodeB");
        address missingNode = makeAddr("missingNode");
        vm.prank(nodeB);
        core.registerNode(contextUID, "0x");
        vm.prank(missingNode);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeB, 100, epoch));

        address challengerB = makeAddr("challengerB");
        address challengerMissing = makeAddr("challengerMissing");
        vm.deal(challengerB, CHALLENGE_BOND);
        vm.deal(challengerMissing, CHALLENGE_BOND);

        vm.prank(challengerB);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, nodeB);
        vm.prank(challengerMissing);
        client.challengeOmission{ value: CHALLENGE_BOND }(epoch, missingNode);

        vm.warp(block.timestamp + RESPONSE_WINDOW + 1);
        client.claimUnansweredChallenge(epoch, missingNode);

        vm.startSnapshotGas("ReclaimMootChallenge");
        client.reclaimMootChallenge(epoch, nodeB);
        vm.stopSnapshotGas();
    }

    /// @notice Cost for the settler to withdraw its bond after an epoch finalizes cleanly.
    function test_Gas_WithdrawSettlementBond() public {
        vm.startPrank(admin);
        client.setDisputeWindow(DISPUTE_WINDOW);
        client.setResponseWindow(RESPONSE_WINDOW);
        client.setSettlementBond(SETTLEMENT_BOND);
        client.setChallengeBond(CHALLENGE_BOND);
        vm.stopPrank();

        address nodeA = makeAddr("nodeA");
        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        _postEpoch(epoch, _leaf(nodeA, 100, epoch));
        vm.warp(block.timestamp + DISPUTE_WINDOW + RESPONSE_WINDOW + 1);

        vm.startSnapshotGas("WithdrawSettlementBond");
        client.withdrawSettlementBond(epoch);
        vm.stopSnapshotGas();
    }
}
