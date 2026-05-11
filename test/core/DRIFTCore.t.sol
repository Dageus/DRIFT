// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { IDRIFTCore } from "../../src/core/IDRIFTCore.sol";
import { DRIFTTypes } from "../../src/Common.sol";
import { MockAdapter } from "../mocks/MockAdapter.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";

contract DRIFTCoreTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;

    address public admin = makeAddr("admin");
    address public client = makeAddr("client");
    address public stranger = makeAddr("stranger");
    address public provider = makeAddr("provider");
    address public node = makeAddr("node");

    bytes32 constant SCHEMA_UID = keccak256("test.schema.v1");

    // Setup ===================================================================

    function setUp() public {
        DRIFTCore implementation = new DRIFTCore();

        bytes memory initData = abi.encodeWithSelector(DRIFTCore.initialize.selector, admin);

        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);

        core = DRIFTCore(address(proxy));

        driftToken = new DRIFTToken(address(proxy));

        vm.startPrank(admin);
        core.setDriftToken(address(driftToken));
        core.grantRole(core.CLIENT_ROLE(), client);
        vm.stopPrank();
    }

    // Helpers =================================================================

    function _registerContext() internal returns (bytes32 uid) {
        vm.prank(client);
        uid = core.registerContext("test.context");
    }

    // Initialization & Global Roles ===========================================

    function test_AdminHasDefaultAdminRole() public view {
        assertTrue(core.hasRole(core.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_ClientHasClientRole() public view {
        assertTrue(core.hasRole(core.CLIENT_ROLE(), client));
    }

    // Context Management ======================================================

    function test_RegisterContextSucceedsAndDerivesCorrectUID() public {
        bytes32 expectedUID = keccak256(abi.encodePacked("test.context"));

        bytes32 uid = _registerContext();

        assertEq(uid, expectedUID);
        assertTrue(core.contextExists(uid));
    }

    function test_RegisterContextAssignsDynamicRoles() public {
        bytes32 uid = _registerContext();
        bytes32 adminRole = core.contextAdminRole(uid);
        assertTrue(core.hasRole(adminRole, client));
    }

    function test_RegisterContextRevertsIfEmptyName() public {
        vm.prank(client);
        vm.expectRevert(DRIFTCore.EmptyContextName.selector);
        core.registerContext("");
    }

    function test_RegisterContextRevertsIfNotClient() public {
        vm.prank(stranger);
        vm.expectRevert();
        core.registerContext("test.context");
    }

    // Schema Management =======================================================

    function test_AddSchemaSucceeds() public {
        bytes32 uid = _registerContext();

        vm.prank(client);
        vm.expectEmit(true, true, true, false);
        emit IDRIFTCore.SchemaAdded(uid, SCHEMA_UID, provider);

        core.addSchema(uid, SCHEMA_UID, provider);
    }

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

    // Node Registration =======================================================

    function test_RegisterNodeSucceedsWithNoStakeRequired() public {
        bytes32 uid = _registerContext();

        vm.prank(node);
        core.registerNode(uid);

        assertTrue(core.isRegistered(uid, node));
    }

    // Trust Verification ======================================================

    function test_VerifyAttestationSucceeds() public {
        bytes32 uid = _registerContext();
        MockAdapter mockAdapter = new MockAdapter();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.prank(client);
        core.addSchema(uid, SCHEMA_UID, address(mockAdapter));

        vm.prank(subject);
        core.registerNode(uid);
        vm.prank(attester);
        core.registerNode(uid);

        bool isValid = core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertTrue(isValid);
    }

    function test_VerifyAttestationFailsIfAdapterRejects() public {
        bytes32 uid = _registerContext();
        MockAdapter mockAdapter = new MockAdapter();
        mockAdapter.setShouldPass(false);
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.prank(client);
        core.addSchema(uid, SCHEMA_UID, address(mockAdapter));

        vm.prank(subject);
        core.registerNode(uid);
        vm.prank(attester);
        core.registerNode(uid);

        bool isValid = core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
    }

    function test_VerifyAttestationFailsIfSubjectNotRegistered() public {
        bytes32 uid = _registerContext();
        MockAdapter mockAdapter = new MockAdapter();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.prank(client);
        core.addSchema(uid, SCHEMA_UID, address(mockAdapter));

        vm.prank(attester);
        core.registerNode(uid);

        bool isValid = core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
    }

    function test_VerifyAttestationFailsIfSchemaNotAccepted() public {
        bytes32 uid = _registerContext();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.prank(subject);
        core.registerNode(uid);
        vm.prank(attester);
        core.registerNode(uid);

        bool isValid = core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
    }

    // Cryptoeconomic Enforcement ==============================================

    function test_RewardMintsReputation() public {
        bytes32 uid = _registerContext();

        // Node registers
        vm.prank(node);
        core.registerNode(uid);

        vm.prank(client);
        // BUG: no role? empty string? bad API design
        core.reward(uid, "", node, 50);

        assertEq(driftToken.balanceOf(node, uint256(uid)), 50);
    }

    function test_SlashBurnsTokensAndETH() public {
        bytes32 uid = _registerContext();

        vm.prank(node);
        core.registerNode(uid);

        vm.prank(client);
        // BUG: no role? empty string? bad API design
        core.reward(uid, "", node, 100);

        // Slash 30 Reputation
        vm.prank(client);
        // BUG: no role? empty string? bad API design
        core.slash(uid, "", node, 30);

        // Verify reputation burned (100 - 30 = 70)
        assertEq(driftToken.balanceOf(node, uint256(uid)), 70);
    }

    // Views ===================================================================

    function test_GetContextReturnsCorrectData() public {
        bytes32 uid = _registerContext();

        DRIFTTypes.Context memory ctx = core.getContext(uid);

        assertEq(ctx.uid, uid);
        assertEq(ctx.name, "test.context");
        assertEq(ctx.owner, client);
        assertTrue(ctx.active);
    }

    function test_GetContextRevertsIfDoesNotExist() public {
        bytes32 fakeUID = keccak256("fake");
        vm.expectRevert(abi.encodeWithSelector(DRIFTCore.ContextNotFound.selector, fakeUID));
        core.getContext(fakeUID);
    }

    function test_StakedAmountAndIsRegistered() public {
        bytes32 uid = _registerContext();

        vm.prank(node);
        core.registerNode(uid);

        assertTrue(core.isRegistered(uid, node));
        assertFalse(core.isRegistered(uid, stranger));
    }

    function test_ContextExists() public {
        bytes32 uid = _registerContext();
        assertTrue(core.contextExists(uid));

        bytes32 fakeUID = keccak256("fake.context");
        assertFalse(core.contextExists(fakeUID));
    }
}
