// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { IDRIFTCore } from "../../src/core/IDRIFTCore.sol";
import { DRIFTTypes } from "../../src/Common.sol";
import { IPolicy, NodeStatus } from "../../src/policies/IPolicy.sol";
import { MockAdapter } from "../mocks/MockAdapter.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";

contract DRIFTCoreTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;

    address public admin = makeAddr("admin");
    address public creator = makeAddr("creator");
    address public stranger = makeAddr("stranger");
    address public provider = makeAddr("provider");
    address public node = makeAddr("node");
    bytes32 constant SCHEMA_UID = keccak256("test.schema.v1");

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

    function test_AdminHasDefaultAdminRole() public view {
        assertTrue(core.hasRole(core.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_RegisterContextSucceedsAndDerivesCorrectUID() public {
        bytes32 expectedUID = keccak256(abi.encodePacked("test.context"));
        bytes32 uid = _registerContext();

        assertEq(uid, expectedUID);
        assertTrue(core.contextExists(uid));
    }

    function test_RegisterContextAssignsDynamicRoles() public {
        bytes32 uid = _registerContext();
        bytes32 adminRole = core.contextAdminRole(uid);
        assertTrue(core.hasRole(adminRole, creator));
    }

    function test_RegisterContextRevertsIfEmptyName() public {
        vm.prank(creator);
        vm.expectRevert(DRIFTCore.EmptyContextName.selector);
        core.registerContext("");
    }

    function test_AddSchemaSucceeds() public {
        bytes32 uid = _registerContext();
        vm.prank(creator);
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

    function test_RegisterNodeSucceedsWithNoPolicy() public {
        bytes32 uid = _registerContext();
        vm.prank(node);
        core.registerNode(uid, "0x");

        assertTrue(core.isRegistered(uid, node));
        assertEq(uint256(core.nodeStatus(uid, node)), uint256(NodeStatus.FULL));
    }

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

        bool isValid = core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertTrue(isValid);
    }

    function test_VerifyAttestationFailsIfSubjectNotRegistered() public {
        bytes32 uid = _registerContext();
        MockAdapter mockAdapter = new MockAdapter();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        vm.prank(creator);
        core.addSchema(uid, SCHEMA_UID, address(mockAdapter));

        vm.prank(attester);
        core.registerNode(uid, "0x");

        bool isValid = core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
    }

    function test_RewardMintsReputation() public {
        bytes32 uid = _registerContext();
        vm.prank(node);
        core.registerNode(uid, "0x");

        vm.prank(creator);
        core.reward(uid, bytes32(0), node, 50);

        uint256 expectedTokenId = uint256(keccak256(abi.encode(uid, bytes32(0))));
        assertEq(driftToken.balanceOf(node, expectedTokenId), 50);
    }

    function test_SlashBurnsTokensWithoutInstantlyKickingNode() public {
        bytes32 uid = _registerContext();
        vm.prank(node);
        core.registerNode(uid, "0x");

        vm.prank(creator);
        core.reward(uid, bytes32(0), node, 100);

        vm.prank(creator);
        core.slash(uid, bytes32(0), node, 30);

        // Verify remaining balance
        uint256 expectedTokenId = uint256(keccak256(abi.encode(uid, bytes32(0))));
        assertEq(driftToken.balanceOf(node, expectedTokenId), 70);

        // Node should STILL be registered because its balance > 0
        assertTrue(core.isRegistered(uid, node));
    }

    function test_SlashKicksNodeIfBalanceHitsZero() public {
        bytes32 uid = _registerContext();
        vm.prank(node);
        core.registerNode(uid, "0x");

        vm.prank(creator);
        core.reward(uid, bytes32(0), node, 100);

        vm.prank(creator);
        core.slash(uid, bytes32(0), node, 100);

        // Node should be automatically wiped to Status.NONE
        assertFalse(core.isRegistered(uid, node));
    }

    function test_GetContextReturnsCorrectData() public {
        bytes32 uid = _registerContext();
        DRIFTTypes.Context memory ctx = core.getContext(uid);

        assertEq(ctx.uid, uid);
        assertEq(ctx.name, "test.context");
        assertEq(ctx.owner, creator);
        assertTrue(ctx.active);
    }
}
