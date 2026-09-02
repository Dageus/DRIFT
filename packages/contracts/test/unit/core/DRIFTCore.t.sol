// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTTypes } from "../../../src/Common.sol";
import { DRIFTCore } from "../../../src/core/DRIFTCore.sol";
import { IDRIFTCore } from "../../../src/core/IDRIFTCore.sol";
import { NodeStatus } from "../../../src/policies/IPolicy.sol";
import { DRIFTToken } from "../../../src/token/DRIFTToken.sol";
import { MockAdapter } from "../../mocks/MockAdapter.sol";
import { MockPolicy } from "../../mocks/MockPolicy.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "forge-std/Test.sol";

contract DRIFTCoreTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;

    address public admin = makeAddr("admin");
    address public creator = makeAddr("creator");
    address public stranger = makeAddr("stranger");
    address public provider = makeAddr("provider");
    address public node = makeAddr("node");

    bytes32 constant SCHEMA_UID = keccak256("test.schema.v1");

    // SETUP ===================================================================

    function setUp() public {
        DRIFTCore implementation = new DRIFTCore();
        bytes memory initData = abi.encodeWithSelector(DRIFTCore.initialize.selector, admin);
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);

        core = DRIFTCore(address(proxy));
        driftToken = new DRIFTToken(address(proxy));

        vm.startPrank(admin);
        core.setDriftToken(address(driftToken));
        vm.stopPrank();
    }

    function _registerContext() internal returns (bytes32 uid) {
        vm.prank(creator);
        uid = core.registerContext("test.context");
    }

    // ACCESS & CONTEXT MANAGEMENT =============================================

    /// @notice Ensures the deployer admin correctly receives the highest level access
    function test_AdminHasDefaultAdminRole() public view {
        assertTrue(core.hasRole(core.DEFAULT_ADMIN_ROLE(), admin));
    }

    /// @notice Validates that context namespaces hash deterministically
    function test_RegisterContextSucceedsAndDerivesCorrectUID() public {
        bytes32 expectedUID = keccak256(abi.encodePacked("test.context"));
        bytes32 uid = _registerContext();

        assertEq(uid, expectedUID);
        assertTrue(core.contextExists(uid));
    }

    /// @notice Ensures the creator of a context is immediately granted local admin rights over it
    function test_RegisterContextAssignsDynamicRoles() public {
        bytes32 uid = _registerContext();
        bytes32 adminRole = core.contextAdminRole(uid);
        assertTrue(core.hasRole(adminRole, creator));
    }

    /// @notice Security audit fix: contextAdminRole(uid) must be self-administering — the
    /// platform's DEFAULT_ADMIN_ROLE holder must NOT be able to grant a permissionlessly
    /// registered context's admin role to anyone without that context's own admin consenting.
    /// Regression test for the cross-context admin takeover found in the final audit: before the
    /// fix, `admin` (DEFAULT_ADMIN_ROLE) could call grantRole(contextAdminRole(uid), attacker) for
    /// any context `creator` ever registered, with no involvement from `creator` at all.
    function test_RevertIf_PlatformAdminGrantsContextAdminRoleWithoutConsent() public {
        bytes32 uid = _registerContext();
        bytes32 adminRole = core.contextAdminRole(uid);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, adminRole
            )
        );
        core.grantRole(adminRole, stranger);

        // The context's own admin can still manage the role themselves (self-administering, not
        // "nobody can ever grant it again").
        vm.prank(creator);
        core.grantRole(adminRole, stranger);
        assertTrue(core.hasRole(adminRole, stranger));
    }

    /// @notice Prevents initialization of malformed context identifiers
    function test_RegisterContextRevertsIfEmptyName() public {
        vm.prank(creator);
        vm.expectRevert(IDRIFTCore.EmptyContextName.selector);
        core.registerContext("");
    }

    /// @notice Validates accurate state retrieval for context structs
    function test_GetContextReturnsCorrectData() public {
        bytes32 uid = _registerContext();
        DRIFTTypes.Context memory ctx = core.getContext(uid);

        assertEq(ctx.uid, uid);
        assertEq(ctx.name, "test.context");
        assertEq(ctx.owner, creator);
        assertTrue(ctx.active);
    }

    // SCHEMAS & ATTESTATIONS ==================================================

    /// @notice Verifies a context admin can bind external data schemas
    function test_AddSchemaSucceeds() public {
        bytes32 uid = _registerContext();

        vm.prank(creator);
        vm.expectEmit(true, true, true, false);
        emit IDRIFTCore.SchemaAdded(uid, SCHEMA_UID, provider);

        core.addSchema(uid, SCHEMA_UID, provider);
    }

    /// @notice Ensures unauthorized actors cannot mutate context schemas
    function test_AddSchemaRevertsIfMissingManagerRole() public {
        bytes32 uid = _registerContext();

        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                core.contextAdminRole(keccak256(abi.encodePacked("test.context")))
            )
        );
        core.addSchema(uid, SCHEMA_UID, provider);
        vm.stopPrank();
    }

    /// @notice Verifies nodes can join a context when no specific access policies are enforced
    function test_RegisterNodeSucceedsWithNoPolicy() public {
        bytes32 uid = _registerContext();

        vm.prank(node);
        core.registerNode(uid, "0x");

        assertTrue(core.isRegistered(uid, node));
        assertEq(uint256(core.nodeStatus(uid, node)), uint256(NodeStatus.FULL));
    }

    /// @notice Ensures the core properly routes attestation validations through mapped adapters
    function test_VerifyAttestationSucceeds() public {
        bytes32 uid = _registerContext();
        MockAdapter mockAdapter = new MockAdapter();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.prank(creator);
        core.addSchema(uid, SCHEMA_UID, address(mockAdapter));

        vm.prank(subject);
        core.registerNode(uid, "0x");
        vm.prank(attester);
        core.registerNode(uid, "0x");

        bool isValid =
            core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertTrue(isValid);
    }

    /// @notice Ensures unregistered subjects cannot receive valid attestations
    function test_VerifyAttestationFailsIfSubjectNotRegistered() public {
        bytes32 uid = _registerContext();
        MockAdapter mockAdapter = new MockAdapter();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.prank(creator);
        core.addSchema(uid, SCHEMA_UID, address(mockAdapter));

        vm.prank(attester);
        core.registerNode(uid, "0x");

        bool isValid =
            core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
    }

    // REPUTATION & PENALTIES ==================================================

    /// @notice Verifies the core properly issues ERC-1155 tokens based on context clients
    function test_RewardMintsReputation() public {
        bytes32 uid = _registerContext();

        vm.prank(node);
        core.registerNode(uid, "0x");

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), admin);
        core.setContextClient(uid, creator, creator);
        vm.stopPrank();

        vm.startPrank(creator);
        core.assignRole(uid, node, bytes32(0));
        core.reward(uid, bytes32(0), node, 50);
        vm.stopPrank();

        uint256 expectedTokenId = uint256(keccak256(abi.encode(uid, bytes32(0))));
        assertEq(driftToken.balanceOf(node, expectedTokenId), 50);
    }

    /// @notice Ensures that slashing decreases balances but does not force removal if balance remains
    function test_SlashBurnsTokensWithoutInstantlyKickingNode() public {
        bytes32 uid = _registerContext();

        vm.prank(node);
        core.registerNode(uid, "0x");

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), admin);
        core.setContextClient(uid, creator, creator);
        vm.stopPrank();

        vm.startPrank(creator);
        core.assignRole(uid, node, bytes32(0));
        core.reward(uid, bytes32(0), node, 100);
        vm.stopPrank();

        vm.prank(creator);
        core.slash(uid, bytes32(0), node, 30);

        uint256 expectedTokenId = uint256(keccak256(abi.encode(uid, bytes32(0))));
        assertEq(driftToken.balanceOf(node, expectedTokenId), 70);
        assertTrue(core.isRegistered(uid, node));
    }

    /// @notice Ensures a node maintains network access even if their reputation drops back to zero
    function test_SlashCanReduceBalanceToZero() public {
        bytes32 uid = _registerContext();

        vm.prank(node);
        core.registerNode(uid, "0x");

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), admin);
        core.setContextClient(uid, creator, creator);
        vm.stopPrank();

        vm.startPrank(creator);
        core.assignRole(uid, node, bytes32(0));
        core.reward(uid, bytes32(0), node, 100);
        vm.stopPrank();

        vm.prank(creator);
        core.slash(uid, bytes32(0), node, 100);

        uint256 expectedTokenId = uint256(keccak256(abi.encode(uid, bytes32(0))));
        assertEq(driftToken.balanceOf(node, expectedTokenId), 0);
        assertTrue(core.isRegistered(uid, node));
    }

    /// @notice Security audit fix: deregisterNode must burn every reputation token the node holds
    /// in that context, so balanceOf can't keep reporting a non-zero balance after isRegistered()
    /// has already gone false — a stale signal any external integration trusting balanceOf as a
    /// membership proxy would otherwise be misled by.
    function test_DeregisterNodeBurnsHeldReputation() public {
        bytes32 uid = _registerContext();
        bytes32 role = keccak256("ROLE_A");
        bytes32 role2 = keccak256("ROLE_B");

        vm.prank(node);
        core.registerNode(uid, "0x");

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), admin);
        core.setContextClient(uid, creator, creator);
        vm.stopPrank();

        vm.startPrank(creator);
        core.assignRole(uid, node, role);
        core.assignRole(uid, node, role2);
        core.reward(uid, role, node, 100);
        core.reward(uid, role2, node, 50);
        vm.stopPrank();

        uint256 tokenId1 = uint256(keccak256(abi.encode(uid, role)));
        uint256 tokenId2 = uint256(keccak256(abi.encode(uid, role2)));
        assertEq(driftToken.balanceOf(node, tokenId1), 100);
        assertEq(driftToken.balanceOf(node, tokenId2), 50);

        vm.prank(node);
        core.deregisterNode(uid);

        assertEq(driftToken.balanceOf(node, tokenId1), 0);
        assertEq(driftToken.balanceOf(node, tokenId2), 0);
        assertFalse(core.isRegistered(uid, node));
    }

    /// @notice A node that deregisters, re-registers, and re-earns the same role must have that
    /// balance tracked again — not silently skipped because _nodeHasEarnedRole was left set from
    /// the first stint. Regression test for the reset-on-deregister half of the fix above.
    function test_DeregisterThenReregisterAndReearn_TracksRoleAgain() public {
        bytes32 uid = _registerContext();
        bytes32 role = keccak256("ROLE_A");
        uint256 tokenId = uint256(keccak256(abi.encode(uid, role)));

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), admin);
        core.setContextClient(uid, creator, creator);
        vm.stopPrank();

        vm.prank(node);
        core.registerNode(uid, "0x");
        vm.startPrank(creator);
        core.assignRole(uid, node, role);
        core.reward(uid, role, node, 100);
        vm.stopPrank();

        vm.prank(node);
        core.deregisterNode(uid);
        assertEq(driftToken.balanceOf(node, tokenId), 0);
        assertFalse(core.hasNodeRole(uid, node, role));

        vm.prank(node);
        core.registerNode(uid, "0x");
        vm.startPrank(creator);
        core.assignRole(uid, node, role);
        core.reward(uid, role, node, 200);
        vm.stopPrank();
        assertEq(driftToken.balanceOf(node, tokenId), 200);

        vm.prank(node);
        core.deregisterNode(uid);
        assertEq(driftToken.balanceOf(node, tokenId), 0);
    }

    /// @notice Security audit fix: setContextClient must independently verify `caller` holds
    /// contextAdminRole(contextUID), not just trust that whatever FACTORY_ROLE holder is calling
    /// already checked. A FACTORY_ROLE holder that (correctly or via a bug) passes a caller who
    /// isn't that context's admin must be rejected regardless of the FACTORY_ROLE gate passing.
    function test_RevertIf_SetContextClientCallerIsNotContextAdmin() public {
        bytes32 uid = _registerContext();

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), admin);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.UnauthorizedCaller.selector, stranger));
        core.setContextClient(uid, creator, stranger);
        vm.stopPrank();
    }

    // ROLE MANAGEMENT ==========================================================

    function _registerWithClient() internal returns (bytes32 uid) {
        uid = _registerContext();
        vm.prank(node);
        core.registerNode(uid, "0x");
        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), admin);
        core.setContextClient(uid, creator, creator);
        vm.stopPrank();
    }

    /// @notice reward() must reject a role the node was never assigned — role acquisition is no
    /// longer implicit on first mint. A compromised settler proving an inflated score cannot use
    /// reward() alone to also manufacture the node's governance-role membership.
    function test_RevertIf_RewardWithoutAssignedRole() public {
        bytes32 uid = _registerWithClient();
        bytes32 role = keccak256("ROLE_A");

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.RoleNotHeld.selector, uid, node, role));
        core.reward(uid, role, node, 100);
    }

    function test_RevertIf_AssignRoleToUnregisteredNode() public {
        bytes32 uid = _registerContext();
        bytes32 role = keccak256("ROLE_A");

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), admin);
        core.setContextClient(uid, creator, creator);
        vm.stopPrank();

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.NodeNotRegistered.selector, uid, node));
        core.assignRole(uid, node, role);
    }

    function test_RevertIf_AssignRoleDuplicate() public {
        bytes32 uid = _registerWithClient();
        bytes32 role = keccak256("ROLE_A");

        vm.startPrank(creator);
        core.assignRole(uid, node, role);
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTCore.RoleAlreadyHeld.selector, uid, node, role)
        );
        core.assignRole(uid, node, role);
        vm.stopPrank();
    }

    function test_RevokeRoleBurnsFullBalance() public {
        bytes32 uid = _registerWithClient();
        bytes32 role = keccak256("ROLE_A");
        uint256 tokenId = uint256(keccak256(abi.encode(uid, role)));

        vm.startPrank(creator);
        core.assignRole(uid, node, role);
        core.reward(uid, role, node, 100);
        assertEq(driftToken.balanceOf(node, tokenId), 100);

        core.revokeRole(uid, node, role);
        vm.stopPrank();

        assertEq(driftToken.balanceOf(node, tokenId), 0);
        assertFalse(core.hasNodeRole(uid, node, role));
    }

    function test_RevertIf_RevokeRoleNotHeld() public {
        bytes32 uid = _registerWithClient();
        bytes32 role = keccak256("ROLE_A");

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.RoleNotHeld.selector, uid, node, role));
        core.revokeRole(uid, node, role);
    }

    function test_RevertIf_AssignRoleCallerNotContextClient() public {
        bytes32 uid = _registerWithClient();
        bytes32 role = keccak256("ROLE_A");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.UnauthorizedCaller.selector, stranger));
        core.assignRole(uid, node, role);
    }

    function test_RevertIf_RevokeRoleCallerNotContextClient() public {
        bytes32 uid = _registerWithClient();
        bytes32 role = keccak256("ROLE_A");

        vm.prank(creator);
        core.assignRole(uid, node, role);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.UnauthorizedCaller.selector, stranger));
        core.revokeRole(uid, node, role);
    }

    function test_HasNodeRoleAndGetNodeRoles_ReflectTransitions() public {
        bytes32 uid = _registerWithClient();
        bytes32 roleA = keccak256("ROLE_A");
        bytes32 roleB = keccak256("ROLE_B");

        assertFalse(core.hasNodeRole(uid, node, roleA));
        assertEq(core.getNodeRoles(uid, node).length, 0);

        vm.startPrank(creator);
        core.assignRole(uid, node, roleA);
        core.assignRole(uid, node, roleB);
        vm.stopPrank();

        assertTrue(core.hasNodeRole(uid, node, roleA));
        assertTrue(core.hasNodeRole(uid, node, roleB));
        bytes32[] memory roles = core.getNodeRoles(uid, node);
        assertEq(roles.length, 2);

        vm.prank(creator);
        core.revokeRole(uid, node, roleA);

        assertFalse(core.hasNodeRole(uid, node, roleA));
        assertTrue(core.hasNodeRole(uid, node, roleB));
        roles = core.getNodeRoles(uid, node);
        assertEq(roles.length, 1);
        assertEq(roles[0], roleB);
    }

    // ACCESS CONTROL ===========================================================

    function test_RevertIf_SetDriftTokenAlreadySet() public {
        vm.prank(admin);
        vm.expectRevert(IDRIFTCore.TokenAlreadySet.selector);
        core.setDriftToken(makeAddr("anotherToken"));
    }

    /// @notice onlyContextAdmin must reject an unregistered contextUID with ContextNotFound
    /// before ever reaching the role check — a stranger passing a bogus UID should not learn
    /// "you're missing a role" (which implies the context exists) vs. "this context doesn't exist".
    function test_RevertIf_OnlyContextAdminModifier_ContextNotFound() public {
        bytes32 fakeUid = keccak256("never.registered");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.ContextNotFound.selector, fakeUid));
        core.setContextPolicy(fakeUid, address(0x1));
    }

    function test_RevertIf_SlashCallerNotContextClient() public {
        bytes32 uid = _registerWithClient();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.UnauthorizedCaller.selector, stranger));
        core.slash(uid, bytes32(0), node, 1);
    }

    function test_RevertIf_RewardCallerNotContextClient() public {
        bytes32 uid = _registerWithClient();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.UnauthorizedCaller.selector, stranger));
        core.reward(uid, bytes32(0), node, 1);
    }

    // ADMISSION POLICIES =======================================================

    function test_RevertIf_RegisterContextTaken() public {
        _registerContext();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDRIFTCore.ContextTaken.selector, keccak256(abi.encodePacked("test.context"))
            )
        );
        core.registerContext("test.context");
    }

    function test_RevertIf_AddSchemaZeroAdapter() public {
        bytes32 uid = _registerContext();

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.InvalidAdapterAddress.selector, uid));
        core.addSchema(uid, SCHEMA_UID, address(0));
    }

    function test_RevertIf_AddSchemaZeroSchemaUID() public {
        bytes32 uid = _registerContext();

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.InvalidSchemaUID.selector, uid));
        core.addSchema(uid, bytes32(0), provider);
    }

    function test_RemoveSchemaSucceeds() public {
        bytes32 uid = _registerContext();

        vm.startPrank(creator);
        core.addSchema(uid, SCHEMA_UID, provider);
        vm.expectEmit(true, true, false, false);
        emit IDRIFTCore.SchemaRemoved(uid, SCHEMA_UID);
        core.removeSchema(uid, SCHEMA_UID);
        vm.stopPrank();

        assertEq(core.getAdapter(uid, SCHEMA_UID), address(0));
    }

    function test_RevertIf_RemoveSchemaNotFound() public {
        bytes32 uid = _registerContext();

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.SchemaNotFound.selector, uid, SCHEMA_UID));
        core.removeSchema(uid, SCHEMA_UID);
    }

    function test_RevertIf_RegisterNodeContextNotActive() public {
        bytes32 fakeUid = keccak256("never.registered");

        vm.prank(node);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.ContextNotActive.selector, fakeUid));
        core.registerNode(fakeUid, "0x");
    }

    function test_RevertIf_RegisterNodeAlreadyRegistered() public {
        bytes32 uid = _registerContext();

        vm.startPrank(node);
        core.registerNode(uid, "0x");
        vm.expectRevert(
            abi.encodeWithSelector(IDRIFTCore.NodeAlreadyRegistered.selector, uid, node)
        );
        core.registerNode(uid, "0x");
        vm.stopPrank();
    }

    /// @notice A configured entry policy's returned NodeStatus is trusted directly — a policy can
    /// admit a node below full standing (e.g. PROBATION) without rejecting entry outright.
    function test_RegisterNode_PolicyGrantsProbationStatus() public {
        bytes32 uid = _registerContext();
        MockPolicy policy = new MockPolicy();
        policy.setStatusToReturn(NodeStatus.PROBATION);

        vm.prank(creator);
        core.setContextPolicy(uid, address(policy));

        vm.prank(node);
        core.registerNode(uid, "0x");

        assertEq(uint256(core.nodeStatus(uid, node)), uint256(NodeStatus.PROBATION));
        // PROBATION is neither NONE nor BANNED, so the node still counts as registered.
        assertTrue(core.isRegistered(uid, node));
    }

    function test_RevertIf_RegisterNode_PolicyRejectsEntry() public {
        bytes32 uid = _registerContext();
        MockPolicy policy = new MockPolicy();
        policy.setStatusToReturn(NodeStatus.NONE);

        vm.prank(creator);
        core.setContextPolicy(uid, address(policy));

        vm.prank(node);
        vm.expectRevert(IDRIFTCore.PolicyRejectedEntry.selector);
        core.registerNode(uid, "0x");
    }

    function test_RevertIf_DeregisterNodeNotRegistered() public {
        bytes32 uid = _registerContext();

        vm.prank(node);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.NodeNotRegistered.selector, uid, node));
        core.deregisterNode(uid);
    }

    function test_SetNodeStatus_AdminTransitionsStatus() public {
        bytes32 uid = _registerContext();
        vm.prank(node);
        core.registerNode(uid, "0x");

        vm.prank(creator);
        core.setNodeStatus(uid, node, NodeStatus.PROBATION);

        assertEq(uint256(core.nodeStatus(uid, node)), uint256(NodeStatus.PROBATION));
    }

    /// @notice Security-relevant permanence guard: once BANNED, setNodeStatus can never move a
    /// node to any other status (including back to BANNED) — banning must be a one-way street
    /// enforced independently of what deregisterNode's own BANNED check does.
    function test_RevertIf_SetNodeStatusCannotUnbanViaStatusUpdate() public {
        bytes32 uid = _registerContext();
        vm.prank(node);
        core.registerNode(uid, "0x");

        vm.startPrank(creator);
        core.setNodeStatus(uid, node, NodeStatus.BANNED);

        vm.expectRevert(IDRIFTCore.CannotUnbanViaStatusUpdate.selector);
        core.setNodeStatus(uid, node, NodeStatus.FULL);
        vm.stopPrank();
    }

    function test_RevertIf_SlashUnregisteredNode() public {
        bytes32 uid = _registerWithClient();
        address other = makeAddr("neverRegistered");

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.NodeNotRegistered.selector, uid, other));
        core.slash(uid, bytes32(0), other, 1);
    }

    function test_RevertIf_RewardUnregisteredNode() public {
        bytes32 uid = _registerWithClient();
        address other = makeAddr("neverRegistered");

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.NodeNotRegistered.selector, uid, other));
        core.reward(uid, bytes32(0), other, 1);
    }

    function test_RevertIf_GetContextNotFound() public {
        bytes32 fakeUid = keccak256("never.registered");

        vm.expectRevert(abi.encodeWithSelector(IDRIFTCore.ContextNotFound.selector, fakeUid));
        core.getContext(fakeUid);
    }

    // PROOF VERIFICATION (verifyAttestation) ===================================

    function test_VerifyAttestation_FalseIfContextInactive() public {
        bytes32 uid = _registerContext();
        MockAdapter mockAdapter = new MockAdapter();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.startPrank(creator);
        core.addSchema(uid, SCHEMA_UID, address(mockAdapter));
        vm.stopPrank();

        vm.prank(subject);
        core.registerNode(uid, "0x");
        vm.prank(attester);
        core.registerNode(uid, "0x");

        vm.prank(creator);
        core.deactivateContext(uid);

        bool isValid =
            core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
    }

    function test_VerifyAttestation_FalseIfSchemaNotAccepted() public {
        bytes32 uid = _registerContext();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.prank(subject);
        core.registerNode(uid, "0x");
        vm.prank(attester);
        core.registerNode(uid, "0x");

        // SCHEMA_UID was never added via addSchema for this context.
        bool isValid =
            core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
    }

    function test_VerifyAttestation_FalseIfAttesterNotRegistered() public {
        bytes32 uid = _registerContext();
        MockAdapter mockAdapter = new MockAdapter();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.prank(creator);
        core.addSchema(uid, SCHEMA_UID, address(mockAdapter));

        vm.prank(subject);
        core.registerNode(uid, "0x");
        // attester never registers.

        bool isValid =
            core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
    }

    function test_VerifyAttestation_FalseIfAttesterBanned() public {
        bytes32 uid = _registerContext();
        MockAdapter mockAdapter = new MockAdapter();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.prank(creator);
        core.addSchema(uid, SCHEMA_UID, address(mockAdapter));

        vm.prank(subject);
        core.registerNode(uid, "0x");
        vm.prank(attester);
        core.registerNode(uid, "0x");

        vm.prank(creator);
        core.setNodeStatus(uid, attester, NodeStatus.BANNED);

        bool isValid =
            core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
    }

    function test_VerifyAttestation_FalseIfSubjectBanned() public {
        bytes32 uid = _registerContext();
        MockAdapter mockAdapter = new MockAdapter();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.prank(creator);
        core.addSchema(uid, SCHEMA_UID, address(mockAdapter));

        vm.prank(subject);
        core.registerNode(uid, "0x");
        vm.prank(attester);
        core.registerNode(uid, "0x");

        vm.prank(creator);
        core.setNodeStatus(uid, subject, NodeStatus.BANNED);

        bool isValid =
            core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
    }
}
