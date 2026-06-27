// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTTypes } from "../../../src/Common.sol";
import { DRIFTCore } from "../../../src/core/DRIFTCore.sol";
import { IDRIFTCore } from "../../../src/core/IDRIFTCore.sol";
import { IPolicy, NodeStatus } from "../../../src/policies/IPolicy.sol";
import { DRIFTToken } from "../../../src/token/DRIFTToken.sol";
import { MockAdapter } from "../../mocks/MockAdapter.sol";
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
        core.setContextClient(uid, creator);
        vm.stopPrank();

        vm.prank(creator);
        core.reward(uid, bytes32(0), node, 50);

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
        core.setContextClient(uid, creator);
        vm.stopPrank();

        vm.prank(creator);
        core.reward(uid, bytes32(0), node, 100);

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
        core.setContextClient(uid, creator);
        vm.stopPrank();

        vm.prank(creator);
        core.reward(uid, bytes32(0), node, 100);

        vm.prank(creator);
        core.slash(uid, bytes32(0), node, 100);

        uint256 expectedTokenId = uint256(keccak256(abi.encode(uid, bytes32(0))));
        assertEq(driftToken.balanceOf(node, expectedTokenId), 0);
        assertTrue(core.isRegistered(uid, node));
    }
}
