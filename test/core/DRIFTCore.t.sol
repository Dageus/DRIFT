// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { IDRIFTCore } from "../../src/core/IDRIFTCore.sol";
import { DRIFTTypes } from "../../src/Common.sol";
import { MockAdapter } from "../mocks/MockAdapter.sol";
import { DRIFTToken } from "../../src/DRIFTToken.sol";

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

    function _registerContext(uint256 minStake) internal returns (bytes32 uid) {
        vm.prank(client);
        // address(0) indicates native ETH for staking
        uid = core.registerContext("test.context", address(0), minStake);
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

        bytes32 uid = _registerContext(0);

        assertEq(uid, expectedUID);
        assertTrue(core.contextExists(uid));
    }

    function test_RegisterContextAssignsDynamicRoles() public {
        bytes32 uid = _registerContext(0);
        bytes32 adminRole = core.contextAdminRole(uid);
        assertTrue(core.hasRole(adminRole, client));
    }

    function test_RegisterContextRevertsIfEmptyName() public {
        vm.prank(client);
        vm.expectRevert(DRIFTCore.EmptyContextName.selector);
        core.registerContext("", address(0), 0);
    }

    function test_RegisterContextRevertsIfNotClient() public {
        vm.prank(stranger);
        vm.expectRevert();
        core.registerContext("test.context", address(0), 0);
    }

    // Schema Management =======================================================

    function test_AddSchemaSucceeds() public {
        bytes32 uid = _registerContext(0);

        vm.prank(client);
        vm.expectEmit(true, true, true, false);
        emit IDRIFTCore.SchemaAdded(uid, SCHEMA_UID, provider);

        core.addSchema(uid, SCHEMA_UID, provider);
    }

    function test_AddSchemaRevertsIfMissingManagerRole() public {
        bytes32 uid = _registerContext(0);

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
        bytes32 uid = _registerContext(0);

        vm.prank(node);
        core.registerNode(uid);

        assertTrue(core.isRegistered(uid, node));
    }

    function test_RegisterNodeSucceedsWithETHStake() public {
        uint256 requiredStake = 1 ether;
        bytes32 uid = _registerContext(requiredStake);

        vm.deal(node, 2 ether);

        vm.prank(node);
        core.registerNode{ value: requiredStake }(uid);

        assertTrue(core.isRegistered(uid, node));
        assertEq(core.stakedAmount(uid, node), requiredStake);
    }

    function test_RegisterNodeRevertsIfInsufficientStake() public {
        uint256 requiredStake = 1 ether;
        bytes32 uid = _registerContext(requiredStake);

        vm.deal(node, 2 ether);

        vm.prank(node);
        vm.expectRevert(abi.encodeWithSelector(DRIFTCore.InsufficientStake.selector, uid, node, 0.5 ether, 1 ether));
        core.registerNode{ value: 0.5 ether }(uid);
    }

    function test_DeregisterEnforcesTimelock() public {
        uint256 requiredStake = 1 ether;
        bytes32 uid = _registerContext(requiredStake);

        vm.deal(node, 1 ether);
        vm.startPrank(node);
        core.registerNode{ value: 1 ether }(uid);

        core.requestDeregister(uid);

        uint256 expectedUnlock = block.timestamp + 7 days;

        vm.expectRevert(
            abi.encodeWithSelector(DRIFTCore.UnbondingPeriodActive.selector, uid, node, expectedUnlock, block.timestamp)
        );
        core.executeDeregister(uid);

        vm.warp(block.timestamp + 7 days);

        uint256 balanceBefore = node.balance;
        core.executeDeregister(uid);

        assertFalse(core.isRegistered(uid, node));
        assertEq(node.balance, balanceBefore + 1 ether);
        vm.stopPrank();
    }

    // Trust Verification ======================================================

    function test_VerifyAttestationSucceeds() public {
        bytes32 uid = _registerContext(0);
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
        bytes32 uid = _registerContext(0);
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
        bytes32 uid = _registerContext(0);
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
        bytes32 uid = _registerContext(0);
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
        uint256 requiredStake = 1 ether;
        bytes32 uid = _registerContext(requiredStake);

        // Node registers
        vm.deal(node, 1 ether);
        vm.prank(node);
        core.registerNode{ value: 1 ether }(uid);

        vm.prank(client);
        core.reward(uid, node, 50);

        assertEq(driftToken.balanceOf(node, uint256(uid)), 50);
    }

    function test_SlashBurnsTokensAndETH() public {
        uint256 requiredStake = 1 ether;
        bytes32 uid = _registerContext(requiredStake);

        // Node registers with extra buffer (2 ETH) so they survive the slash
        vm.deal(node, 2 ether);
        vm.prank(node);
        core.registerNode{ value: 2 ether }(uid);

        vm.prank(client);
        core.reward(uid, node, 100);

        // Track the dead address balance before slash
        uint256 deadBalanceBefore = core.BURN_ADDRESS().balance;

        // Slash 0.5 ETH and 30 Reputation
        vm.prank(client);
        // BUG: separate values for slashing eth and reputation?
        core.slash(uid, node, 0.5 ether);

        // Verify internal stake decreased (2.0 - 0.5 = 1.5)
        // (Assuming you have a getter like getStake(uid, node) or just check via helper)
        uint256 currentStake = core.getStake(uid, node);
        assertEq(currentStake, 1.5 ether);

        // Verify reputation burned (100 - 30 = 70)
        assertEq(driftToken.balanceOf(node, uint256(uid)), 70);

        // Verify physical ETH arrived at BURN_ADDRESS
        assertEq(core.BURN_ADDRESS().balance, deadBalanceBefore + 0.5 ether);
    }

    function test_SlashEconomicDeregistration() public {
        uint256 requiredStake = 1 ether;
        bytes32 uid = _registerContext(requiredStake);

        // Node registers with exactly 1.2 ETH
        vm.deal(node, 1.2 ether);
        vm.prank(node);
        core.registerNode{ value: 1.2 ether }(uid);

        // Slash 0.5 ETH. New balance (0.7) is below the 1.0 minimum.
        vm.prank(client);
        // BUG: separate values for slashing eth and reputation?
        core.slash(uid, node, 1.2 ether);

        uint256 currentStake = core.getStake(uid, node);
        assertEq(currentStake, 0);
    }

    // Views ===================================================================

    function test_GetContextReturnsCorrectData() public {
        bytes32 uid = _registerContext(1 ether);

        DRIFTTypes.Context memory ctx = core.getContext(uid);

        assertEq(ctx.uid, uid);
        assertEq(ctx.name, "test.context");
        assertEq(ctx.owner, client);
        assertTrue(ctx.active);
        assertEq(ctx.minimumStake, 1 ether);
        assertEq(ctx.stakeToken, address(0));
    }

    function test_GetContextRevertsIfDoesNotExist() public {
        bytes32 fakeUID = keccak256("fake");
        vm.expectRevert(abi.encodeWithSelector(DRIFTCore.ContextNotFound.selector, fakeUID));
        core.getContext(fakeUID);
    }

    function test_StakedAmountAndIsRegistered() public {
        uint256 requiredStake = 2 ether;
        bytes32 uid = _registerContext(requiredStake);

        vm.deal(node, requiredStake);
        vm.prank(node);
        core.registerNode{ value: requiredStake }(uid);

        assertTrue(core.isRegistered(uid, node));
        assertEq(core.stakedAmount(uid, node), requiredStake);

        assertFalse(core.isRegistered(uid, stranger));
        assertEq(core.stakedAmount(uid, stranger), 0);
    }

    function test_ContextExists() public {
        bytes32 uid = _registerContext(0);
        assertTrue(core.contextExists(uid));

        bytes32 fakeUID = keccak256("fake.context");
        assertFalse(core.contextExists(fakeUID));
    }
}
