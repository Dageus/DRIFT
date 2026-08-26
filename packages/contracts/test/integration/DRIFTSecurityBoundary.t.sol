// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTClientFactory } from "../../src/client/DRIFTClientFactory.sol";
import { IDRIFTGovernance } from "../../src/client/IDRIFTGovernance.sol";
import { IDRIFTGovernanceProofOfState } from "../../src/client/IDRIFTGovernanceProofOfState.sol";
import { IDRIFTSettler } from "../../src/client/IDRIFTSettler.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "forge-std/Test.sol";

contract DRIFTSecurityBoundaryTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public client;

    address public admin = makeAddr("admin");
    address public alice = makeAddr("alice");
    address public attacker = makeAddr("attacker");

    uint256 public settlerPk = 0x1234;
    address public settler = vm.addr(settlerPk);
    bytes32 public contextUID;
    bytes32 constant ROLE = keccak256("ROLE");

    uint256 public proposalId;

    // B1 test cadence: epochLength must exceed disputeWindow + responseWindow.
    uint256 constant EPOCH_LENGTH = 10;
    uint256 constant DISPUTE_WINDOW = 1;
    uint256 constant RESPONSE_WINDOW = 1;
    uint256 constant SETTLEMENT_BOND = 0.001 ether;

    /// @dev Rolls past a client's current dispute+response windows so its latest posted root
    ///      finalizes and becomes usable by claim/governance reads.
    function _rollPastFinalization(
        WeightedGovernanceClient c
    ) internal {
        vm.roll(block.number + c.disputeWindow() + c.responseWindow() + 1);
    }

    // SETUP ===================================================================

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

        factory = new DRIFTClientFactory(address(core));
        WeightedGovernanceClient template = new WeightedGovernanceClient();

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), address(factory));
        contextUID = core.registerContext("test.security");

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
        vm.stopPrank();

        vm.prank(alice);
        core.registerNode(contextUID, "0x");

        vm.prank(attacker);
        core.registerNode(contextUID, "0x");

        uint256 epoch = 1;
        uint256 setupScore = 1000;
        bytes32 setupLeaf = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, admin, ROLE, setupScore, epoch)))
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("DRIFT_WeightedGovernance"),
                keccak256("1"),
                block.chainid,
                address(client)
            )
        );

        bytes32 structHash = keccak256(
            abi.encode(client.SETTLE_ROOT_TYPEHASH(), contextUID, epoch, setupLeaf, keccak256(""))
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerPk, digest);

        vm.roll(client.epochAnchorBlock() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, setupLeaf, "", abi.encodePacked(r, s, v)
        );
        _rollPastFinalization(client);

        bytes32[] memory setupRoles = new bytes32[](1);
        setupRoles[0] = ROLE;
        uint256[] memory setupScores = new uint256[](1);
        setupScores[0] = setupScore;
        bytes32[][] memory setupProofs = new bytes32[][](1);
        setupProofs[0] = new bytes32[](0);

        vm.prank(admin);
        proposalId = client.createProposalWithProofs(
            "Target Proposal", address(0), "", 3, setupRoles, setupScores, setupProofs
        );
    }

    // BOUNDARY TESTS ==========================================================

    /// @notice Ensures an attacker cannot forge voting power by passing a valid user's leaf/proof
    function test_RevertIf_ProofHijacking() public {
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;

        uint256[] memory scores = new uint256[](1);
        scores[0] = 1000;

        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](1);
        proofs[0] = new bytes32[](0);

        vm.startPrank(attacker);
        vm.expectRevert(IDRIFTSettler.InvalidMerkleProof.selector);
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);
        vm.stopPrank();
    }

    /// @notice Ensures votes are locked to the snapshot epoch; prevents reusing future high scores
    function test_RevertIf_EpochReuse() public {
        uint256 score = 500;
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory scores = new uint256[](1);
        scores[0] = score;
        bytes32[][] memory epoch2Proofs = new bytes32[][](1);

        vm.startPrank(attacker);
        vm.expectRevert(IDRIFTSettler.InvalidMerkleProof.selector);
        client.castVoteWithProofs(proposalId, true, roles, scores, epoch2Proofs);
        vm.stopPrank();
    }

    /// @notice Validates interface safeguards against malformed calldata
    function test_RevertIf_ArrayLengthMismatch() public {
        bytes32[] memory roles = new bytes32[](2);
        uint256[] memory scores = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](2);

        vm.startPrank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTGovernanceProofOfState.InvalidProofCount.selector, 2, 1, 2)
        );
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);
        vm.stopPrank();
    }

    /// @notice End-to-end verification of multi-leaf tree generation and voting execution
    function test_Verify_MultiLeafTree() public {
        uint256 epoch = 2;
        address nodeA = makeAddr("nodeA");
        address nodeB = makeAddr("nodeB");
        address nodeC = makeAddr("nodeC");
        address nodeD = makeAddr("nodeD");

        vm.prank(nodeA);
        core.registerNode(contextUID, "0x");
        vm.prank(nodeB);
        core.registerNode(contextUID, "0x");

        bytes32 leafA =
            keccak256(bytes.concat(keccak256(abi.encode(contextUID, nodeA, ROLE, 1000, epoch))));
        bytes32 leafB =
            keccak256(bytes.concat(keccak256(abi.encode(contextUID, nodeB, ROLE, 200, epoch))));
        bytes32 leafC =
            keccak256(bytes.concat(keccak256(abi.encode(contextUID, nodeC, ROLE, 300, epoch))));
        bytes32 leafD =
            keccak256(bytes.concat(keccak256(abi.encode(contextUID, nodeD, ROLE, 400, epoch))));

        bytes32 hashAB = _hashPair(leafA, leafB);
        bytes32 hashCD = _hashPair(leafC, leafD);
        bytes32 root = _hashPair(hashAB, hashCD);

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("DRIFT_WeightedGovernance"),
                keccak256("1"),
                block.chainid,
                address(client)
            )
        );

        bytes32 structHash = keccak256(
            abi.encode(client.SETTLE_ROOT_TYPEHASH(), contextUID, epoch, root, keccak256(""))
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerPk, digest);

        vm.roll(client.epochAnchorBlock() + client.epochLength() * epoch);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", abi.encodePacked(r, s, v));
        _rollPastFinalization(client);

        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](2);
        proofs[0][0] = leafB;
        proofs[0][1] = hashCD;

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory scores = new uint256[](1);
        scores[0] = 1000;

        vm.startPrank(nodeA);
        uint256 newProposalId = client.createProposalWithProofs(
            "Multi-Leaf Proposal", address(0), "", 3, roles, scores, proofs
        );
        client.castVoteWithProofs(newProposalId, true, roles, scores, proofs);
        vm.stopPrank();

        (,,, uint256 votesFor,,,,) = client.getProposal(newProposalId);
        assertEq(votesFor, 1000);
    }

    /// @notice Ensures a user cannot double-spend their reputation on the same proposal
    function test_RevertIf_DoubleVote() public {
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory scores = new uint256[](1);
        scores[0] = 1000;

        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.startPrank(admin);

        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);

        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTGovernance.AlreadyVoted.selector, admin, proposalId)
        );
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);

        vm.stopPrank();
    }

    /// @notice Ensures voting power is strictly locked to the proposal's snapshot epoch.
    /// @dev Prevents an attacker from farming reputation in Epoch 2 and using it on an Epoch 1 proposal.
    function test_RevertIf_StaleEpochReplay() public {
        uint256 epoch2 = 2;
        uint256 aliceHugeScore = 999999;

        bytes32 aliceLeaf = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, alice, ROLE, aliceHugeScore, epoch2)))
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("DRIFT_WeightedGovernance"),
                keccak256("1"),
                block.chainid,
                address(client)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(client.SETTLE_ROOT_TYPEHASH(), contextUID, epoch2, aliceLeaf, keccak256(""))
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerPk, digest);

        vm.roll(client.epochAnchorBlock() + client.epochLength() * epoch2);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch2, aliceLeaf, "", abi.encodePacked(r, s, v)
        );

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory scores = new uint256[](1);
        scores[0] = aliceHugeScore;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.startPrank(alice);

        vm.expectRevert(IDRIFTSettler.InvalidMerkleProof.selector);
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);

        vm.stopPrank();
    }

    /// @notice P3 output isolation: a leaf/proof valid in context c1 must not be usable as voting
    /// power in a different client c2's governance, even when the identical root bytes are posted
    /// for c2. The client reconstructs the leaf from its OWN immutable `contextUID` (never a
    /// caller-supplied one), so a leaf hash that recomputes correctly for c1 recomputes to a
    /// different value under c2 — this is what should make the replay fail.
    function test_RevertIf_CrossContextProofReplay() public {
        (bytes32 contextUID2, WeightedGovernanceClient clientB) = _deployContextBClient();

        // Root bytes numerically equal to context1's admin leaf (from setUp), posted for context2
        // under a genuine, independently-valid settler signature (the EIP-712 digest binds
        // contextUID2, so this is not itself a forged signature).
        uint256 epoch = 1;
        uint256 setupScore = 1000;
        bytes32 leafFromContext1 = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, admin, ROLE, setupScore, epoch)))
        );

        bytes32 domainSeparatorB = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("DRIFT_WeightedGovernance"),
                keccak256("1"),
                block.chainid,
                address(clientB)
            )
        );
        bytes32 structHashB = keccak256(
            abi.encode(
                clientB.SETTLE_ROOT_TYPEHASH(), contextUID2, epoch, leafFromContext1, keccak256("")
            )
        );
        bytes32 digestB = MessageHashUtils.toTypedDataHash(domainSeparatorB, structHashB);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerPk, digestB);

        vm.roll(clientB.epochAnchorBlock() + clientB.epochLength() * epoch);
        clientB.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, leafFromContext1, "", abi.encodePacked(r, s, v)
        );
        _rollPastFinalization(clientB);

        // Replay context1's (leaf-producing) admin claim verbatim against clientB.
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory scores = new uint256[](1);
        scores[0] = setupScore;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.startPrank(admin);
        vm.expectRevert(IDRIFTSettler.InvalidMerkleProof.selector);
        clientB.createProposalWithProofs(
            "Cross-Context Replay Attempt", address(0), "", 3, roles, scores, proofs
        );
        vm.stopPrank();
    }

    // FUZZ TESTS ==============================================================

    /// @notice Malformed (garbage-sibling) proofs must never verify, regardless of the claimed
    /// score value.
    function testFuzz_RevertIf_MalformedProof(
        uint256 score,
        bytes32 garbageSibling
    ) public {
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory scores = new uint256[](1);
        scores[0] = score;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](1);
        proofs[0][0] = garbageSibling;

        vm.prank(admin);
        vm.expectRevert(IDRIFTSettler.InvalidMerkleProof.selector);
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);
    }

    /// @notice A leaf/proof valid for a later epoch must never be usable against a proposal
    /// snapshotted at an earlier epoch, for any score magnitude (generalizes
    /// test_RevertIf_StaleEpochReplay beyond its single hardcoded score).
    function testFuzz_RevertIf_WrongEpochProofReplay(
        uint256 futureScore
    ) public {
        uint256 epoch2 = 2;
        bytes32 futureLeaf = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, alice, ROLE, futureScore, epoch2)))
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("DRIFT_WeightedGovernance"),
                keccak256("1"),
                block.chainid,
                address(client)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(client.SETTLE_ROOT_TYPEHASH(), contextUID, epoch2, futureLeaf, keccak256(""))
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerPk, digest);

        vm.roll(client.epochAnchorBlock() + client.epochLength() * epoch2);
        client.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch2, futureLeaf, "", abi.encodePacked(r, s, v)
        );

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory scores = new uint256[](1);
        scores[0] = futureScore;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.prank(alice);
        vm.expectRevert(IDRIFTSettler.InvalidMerkleProof.selector);
        client.castVoteWithProofs(proposalId, true, roles, scores, proofs);
    }

    /// @notice Settlement's monotonic epoch nonce rejects any epoch other than currentEpoch + 1 —
    /// covers both stale-nonce replay (badEpoch <= currentEpoch) and premature future postings
    /// (badEpoch > currentEpoch + 1), keeping settlement strictly sequential.
    function testFuzz_RevertIf_PostEpochRootWrongNonce(
        uint256 badEpoch
    ) public {
        vm.assume(badEpoch != client.currentEpoch() + 1);

        bytes32 root = keccak256(abi.encode("fuzz-root", badEpoch));

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("DRIFT_WeightedGovernance"),
                keccak256("1"),
                block.chainid,
                address(client)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(client.SETTLE_ROOT_TYPEHASH(), contextUID, badEpoch, root, keccak256(""))
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerPk, digest);

        vm.expectRevert(
            abi.encodeWithSelector(
                WeightedGovernanceClient.InvalidEpoch.selector, badEpoch, client.currentEpoch() + 1
            )
        );
        client.postEpochRoot(badEpoch, root, "", abi.encodePacked(r, s, v));
    }

    /// @notice Generalizes test_RevertIf_CrossContextProofReplay (P3 output isolation) beyond its
    /// single hardcoded proposer/score: for any claimed identity and score, a leaf/root that
    /// verifies in context1 must never verify in context2, since each client reconstructs the leaf
    /// from its own immutable `contextUID`.
    function testFuzz_RevertIf_CrossContextProofReplay(
        address proposer,
        uint256 setupScore
    ) public {
        (bytes32 contextUID2, WeightedGovernanceClient clientB) = _deployContextBClient();

        uint256 epoch = 1;
        bytes32 leafFromContext1 = keccak256(
            bytes.concat(keccak256(abi.encode(contextUID, proposer, ROLE, setupScore, epoch)))
        );

        bytes32 domainSeparatorB = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("DRIFT_WeightedGovernance"),
                keccak256("1"),
                block.chainid,
                address(clientB)
            )
        );
        bytes32 structHashB = keccak256(
            abi.encode(
                clientB.SETTLE_ROOT_TYPEHASH(), contextUID2, epoch, leafFromContext1, keccak256("")
            )
        );
        bytes32 digestB = MessageHashUtils.toTypedDataHash(domainSeparatorB, structHashB);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerPk, digestB);

        vm.roll(clientB.epochAnchorBlock() + clientB.epochLength() * epoch);
        clientB.postEpochRoot{ value: SETTLEMENT_BOND }(
            epoch, leafFromContext1, "", abi.encodePacked(r, s, v)
        );
        _rollPastFinalization(clientB);

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory scores = new uint256[](1);
        scores[0] = setupScore;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.prank(proposer);
        vm.expectRevert(IDRIFTSettler.InvalidMerkleProof.selector);
        clientB.createProposalWithProofs(
            "Cross-Context Replay Attempt", address(0), "", 3, roles, scores, proofs
        );
    }

    // INTERNAL HELPERS ========================================================

    /// @dev Deploys a second, independent WeightedGovernanceClient (context2), fully configured
    /// with the same B1 windows/bond as the main `client` — shared by
    /// test_RevertIf_CrossContextProofReplay and its fuzz generalization.
    function _deployContextBClient()
        internal
        returns (bytes32 contextUID2, WeightedGovernanceClient clientB)
    {
        vm.startPrank(admin);
        contextUID2 = core.registerContext(
            string(abi.encodePacked("test.security.other.", block.number, gasleft()))
        );

        bytes32[] memory roles2 = new bytes32[](1);
        roles2[0] = ROLE;
        uint256[] memory weights2 = new uint256[](1);
        weights2[0] = 10_000;

        WeightedGovernanceClient templateB = new WeightedGovernanceClient();
        bytes memory initDataB = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID2,
            settler,
            0,
            0,
            "EigenTrust",
            roles2,
            weights2
        );
        address cloneAddrB = factory.deployClient(
            contextUID2, address(templateB), initDataB, bytes32(block.number)
        );
        clientB = WeightedGovernanceClient(cloneAddrB);
        core.grantRole(core.contextAdminRole(contextUID2), address(clientB));
        clientB.setEpochLength(EPOCH_LENGTH);
        clientB.setDisputeWindow(DISPUTE_WINDOW);
        clientB.setResponseWindow(RESPONSE_WINDOW);
        clientB.setSettlementBond(SETTLEMENT_BOND);
        vm.stopPrank();
    }

    function _hashPair(
        bytes32 a,
        bytes32 b
    ) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
