// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import "../src/SBT.sol";

contract DriftIdentityTest is Test {
    DRIFT_Identity public sbt;

    address public admin = makeAddr("admin");
    address public engine = makeAddr("engine");
    address public nodeA = makeAddr("nodeA");
    address public nodeB = makeAddr("nodeB");
    address public stranger = makeAddr("stranger");

    // Mirrors the contract constant
    uint256 constant SCORE_SCALE = 10_000;
    uint256 constant INITIAL_SCORE = 5_000;
    uint256 constant BASE_STAKE = 100 ether;

    // Setup ========================================================

    function setUp() public {
        vm.startPrank(admin);
        sbt = new DRIFT_Identity();
        sbt.grantRole(sbt.ENGINE_ROLE(), engine);
        vm.stopPrank();
    }

    // Helpers ======================================================

    /// Mint a fresh identity for `node` via the engine.
    function _mintFor(address node) internal returns (uint256 tokenId) {
        vm.prank(engine);
        sbt.mint(node, BASE_STAKE);
        tokenId = sbt.tokenOf(node);
    }

    // Deployment & roles ===========================================

    function test_AdminHasDefaultAdminRole() public view {
        assertTrue(sbt.hasRole(sbt.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_EngineHasEngineRole() public view {
        assertTrue(sbt.hasRole(sbt.ENGINE_ROLE(), engine));
    }

    function test_StrangerHasNoRoles() public view {
        assertFalse(sbt.hasRole(sbt.ENGINE_ROLE(), stranger));
        assertFalse(sbt.hasRole(sbt.DEFAULT_ADMIN_ROLE(), stranger));
    }

    // Minting ======================================================

    function test_MintSucceeds() public {
        uint256 tokenId = _mintFor(nodeA);

        assertEq(sbt.ownerOf(tokenId), nodeA);
        assertEq(sbt.balanceOf(nodeA), 1);
        assertEq(sbt.tokenOf(nodeA), tokenId);
    }

    function test_MintSetsInitialScore() public {
        _mintFor(nodeA);
        DRIFT_Identity.Identity memory id = sbt.getIdentity(nodeA);
        assertEq(id.perfScore, INITIAL_SCORE);
    }

    // FIXME: add support for the Epoch Manager later on
    function test_MintSetsJoinEpoch() public {
        // Warp to a known timestamp so we can assert against it
        vm.warp(1_000_000);
        _mintFor(nodeA);
        DRIFT_Identity.Identity memory id = sbt.getIdentity(nodeA);
        assertEq(id.joinTimestamp, 1_000_000);
    }

    function test_MintSetsStakedAmount() public {
        vm.prank(engine);
        sbt.mint(nodeA, BASE_STAKE);
        DRIFT_Identity.Identity memory id = sbt.getIdentity(nodeA);
        assertEq(id.initialStake, BASE_STAKE);
    }

    function test_MintTokenIdsIncrement() public {
        uint256 idA = _mintFor(nodeA);
        uint256 idB = _mintFor(nodeB);
        assertEq(idB, idA + 1);
    }

    function test_MintRevertsForZeroAddress() public {
        vm.prank(engine);
        vm.expectRevert("DRIFT: Cannot mint to zero address");
        sbt.mint(address(0), BASE_STAKE);
    }

    function test_MintRevertsIfAlreadyHasIdentity() public {
        _mintFor(nodeA);
        vm.prank(engine);
        vm.expectRevert("DRIFT: Address already has an identity");
        sbt.mint(nodeA, BASE_STAKE);
    }

    function test_MintRevertsIfCallerNotEngine() public {
        vm.prank(stranger);
        vm.expectRevert(); // AccessControl revert
        sbt.mint(nodeA, BASE_STAKE);
    }

    function test_MintEmitsIdentityMinted() public {
        vm.prank(engine);
        // Token ID will be 1 (first mint)
        vm.expectEmit(true, true, true, false);
        emit DRIFT_Identity.IdentityMinted(
            nodeA,
            1,
            BASE_STAKE,
            block.timestamp
        );
        sbt.mint(nodeA, BASE_STAKE);
    }

    // Soulbound logic testing ======================================

    function test_TransferReverts() public {
        uint256 tokenId = _mintFor(nodeA);
        vm.prank(nodeA);
        vm.expectRevert("DRIFT: Soulbound token cannot be transferred");
        sbt.transferFrom(nodeA, nodeB, tokenId);
    }

    function test_SafeTransferReverts() public {
        uint256 tokenId = _mintFor(nodeA);
        vm.prank(nodeA);
        vm.expectRevert("DRIFT: Soulbound token cannot be transferred");
        sbt.safeTransferFrom(nodeA, nodeB, tokenId);
    }

    function test_ApproveAndTransferReverts() public {
        uint256 tokenId = _mintFor(nodeA);
        vm.startPrank(nodeA);
        sbt.approve(stranger, tokenId);
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert("DRIFT: Soulbound token cannot be transferred");
        sbt.transferFrom(nodeA, nodeB, tokenId);
    }

    // Reputation updates ===========================================

    function test_UpdateReputationSucceeds() public {
        _mintFor(nodeA);

        vm.prank(engine);
        sbt.updateReputation(nodeA, 7_500);

        DRIFT_Identity.Identity memory id = sbt.getIdentity(nodeA);
        assertEq(id.perfScore, 7_500);
    }

    function test_UpdateReputationEmitsEvent() public {
        uint256 tokenId = _mintFor(nodeA);

        vm.prank(engine);
        vm.expectEmit(true, true, false, true);
        emit DRIFT_Identity.ReputationUpdated(nodeA, tokenId, 7_500);
        sbt.updateReputation(nodeA, 7_500);
    }

    function test_UpdateReputationRevertsIfNotEngine() public {
        _mintFor(nodeA);

        vm.prank(stranger);
        vm.expectRevert();
        sbt.updateReputation(nodeA, 7_500);
    }

    function test_UpdateReputa() public {
        _mintFor(nodeA);

        vm.prank(engine);
        sbt.banNode(nodeA);

        vm.prank(engine);
        vm.expectRevert("DRIFT: Cannot update a banned node");
        sbt.updateReputation(nodeA, 7_500);
    }

    function test_UpdateReputationRevertsIfScoreExceedsMax() public {
        _mintFor(nodeA);

        vm.prank(engine);
        vm.expectRevert("DRIFT: Score exceeds maximum scale");
        sbt.updateReputation(nodeA, SCORE_SCALE + 1);
    }

    function test_UpdateReputationAtMaxScore() public {
        _mintFor(nodeA);

        vm.prank(engine);
        sbt.updateReputation(nodeA, SCORE_SCALE); // exactly 1.0 — should pass

        DRIFT_Identity.Identity memory id = sbt.getIdentity(nodeA);
        assertEq(id.perfScore, SCORE_SCALE);
    }

    // Banning ======================================================

    function test_BanNodeSucceeds() public {
        _mintFor(nodeA);

        vm.prank(engine);
        sbt.banNode(nodeA);

        DRIFT_Identity.Identity memory id = sbt.getIdentity(nodeA);
        assertTrue(id.isBanned);
        assertEq(id.perfScore, 0);
    }

    function test_BanNodeBurnsSBT() public {
        uint256 tokenId = _mintFor(nodeA);

        vm.prank(engine);
        sbt.banNode(nodeA);

        // Token no longer exists
        vm.expectRevert();
        sbt.ownerOf(tokenId);

        assertEq(sbt.balanceOf(nodeA), 0);
    }

    function test_BanNodeEmitsEvent() public {
        uint256 tokenId = _mintFor(nodeA);

        vm.prank(engine);
        vm.expectEmit(true, true, false, false);
        emit DRIFT_Identity.NodeBanned(nodeA, tokenId);
        sbt.banNode(nodeA);
    }

    function test_BanNodeRevertsIfAlreadyBanned() public {
        _mintFor(nodeA);

        vm.startPrank(engine);
        sbt.banNode(nodeA);
        vm.expectRevert("DRIFT: Node is already banned");
        sbt.banNode(nodeA);
        vm.stopPrank();
    }

    function test_BanNodeRevertsIfNotEngine() public {
        _mintFor(nodeA);

        vm.prank(stranger);
        vm.expectRevert();
        sbt.banNode(nodeA);
    }

    // Fuzz tests ===================================================

    /// Any score within [0, SCORE_SCALE] must be accepted.
    function testFuzz_UpdateReputationValidRange(uint256 score) public {
        score = bound(score, 0, SCORE_SCALE);
        _mintFor(nodeA);

        vm.prank(engine);
        sbt.updateReputation(nodeA, score);

        assertEq(sbt.getIdentity(nodeA).perfScore, score);
    }

    /// Any score above SCORE_SCALE must revert.
    function testFuzz_UpdateReputationInvalidRange(uint256 score) public {
        score = bound(score, SCORE_SCALE + 1, type(uint256).max);
        _mintFor(nodeA);

        vm.prank(engine);
        vm.expectRevert("DRIFT: Score exceeds maximum scale");
        sbt.updateReputation(nodeA, score);
    }

    /// Mint should always succeed for fresh addresses regardless of stake amount.
    function testFuzz_MintAnyStake(uint256 stake) public {
        vm.prank(engine);
        sbt.mint(nodeA, stake);
        assertEq(sbt.balanceOf(nodeA), 1);
    }

    // Interface support ============================================

    function test_SupportsERC721Interface() public view {
        assertTrue(sbt.supportsInterface(type(IERC721).interfaceId));
    }

    function test_SupportsAccessControlInterface() public view {
        assertTrue(sbt.supportsInterface(type(IAccessControl).interfaceId));
    }
}
