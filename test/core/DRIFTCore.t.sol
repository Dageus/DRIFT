// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { IDRIFTCore } from "../../src/interfaces/IDRIFTCore.sol";
import { DRIFTTypes } from "../../src/Common.sol";

contract DRIFTCoreTest is Test {
    DRIFTCore public core;

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

        // Grant CLIENT_ROLE so client can register contexts
        vm.prank(admin);
        core.grantRole(core.CLIENT_ROLE(), client);
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
        bytes32 expectedUID = keccak256(abi.encodePacked("test.context", client));

        bytes32 uid = _registerContext(0);

        assertEq(uid, expectedUID);
        assertTrue(core.contextExists(uid));
    }

    function test_RegisterContextAssignsDynamicRoles() public {
        bytes32 uid = _registerContext(0);

        bytes32 adminRole = core.getContextAdminRole(uid);
        bytes32 managerRole = core.getSchemaManagerRole(uid);

        // Client should hold both roles
        assertTrue(core.hasRole(adminRole, client));
        assertTrue(core.hasRole(managerRole, client));

        // Admin role should be the administrator of the manager role
        assertEq(core.getRoleAdmin(managerRole), adminRole);
    }

    function test_RegisterContextRevertsIfEmptyName() public {
        vm.prank(client);
        vm.expectRevert("DRIFT: empty context name");
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

        vm.prank(stranger);
        vm.expectRevert("DRIFT: missing schema manager role");
        core.addSchema(uid, SCHEMA_UID, provider);
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
        vm.expectRevert("DRIFT: insufficient ETH stake");
        core.registerNode{ value: 0.5 ether }(uid);
    }

    function test_DeregisterEnforcesTimelock() public {
        uint256 requiredStake = 1 ether;
        bytes32 uid = _registerContext(requiredStake);

        vm.deal(node, 1 ether);
        vm.startPrank(node);
        core.registerNode{ value: 1 ether }(uid);

        // Step 1: Request
        core.requestDeregister(uid);

        // Step 2: Try to execute immediately (should fail)
        vm.expectRevert("DRIFT: unbonding period active");
        core.executeDeregister(uid);

        // Fast forward 7 days (the UNBONDING_PERIOD)
        vm.warp(block.timestamp + 7 days);

        // Step 3: Execute after timelock (should succeed)
        uint256 balanceBefore = node.balance;
        core.executeDeregister(uid);

        assertFalse(core.isRegistered(uid, node));
        assertEq(node.balance, balanceBefore + 1 ether); // Stake returned
        vm.stopPrank();
    }

    // Trust Verification ======================================================

    function test_VerifyAttestationSucceeds() public {
        bytes32 uid = _registerContext(0);
        MockAdapter mockAdapter = new MockAdapter();
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        // Setup: Add schema mapped to mock adapter
        vm.prank(client);
        core.addSchema(uid, SCHEMA_UID, address(mockAdapter));

        // Setup: Register both nodes
        vm.prank(subject);
        core.registerNode(uid);
        vm.prank(attester);
        core.registerNode(uid);

        // Verification should pass
        bool isValid = core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertTrue(isValid);
    }

    function test_VerifyAttestationFailsIfAdapterRejects() public {
        bytes32 uid = _registerContext(0);
        MockAdapter mockAdapter = new MockAdapter();
        mockAdapter.setShouldPass(false); // Force adapter to reject
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

        // Only register attester, intentionally leave subject unregistered
        vm.prank(attester);
        core.registerNode(uid);

        bool isValid = core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
    }

    function test_VerifyAttestationFailsIfSchemaNotAccepted() public {
        bytes32 uid = _registerContext(0);
        address subject = makeAddr("subject");
        address attester = makeAddr("attester");

        // Do NOT add the schema to the context

        vm.prank(subject);
        core.registerNode(uid);
        vm.prank(attester);
        core.registerNode(uid);

        bool isValid = core.verifyAttestation(uid, SCHEMA_UID, keccak256("att.uid"), subject, attester);
        assertFalse(isValid);
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
        vm.expectRevert("DRIFT: context not found");
        core.getContext(fakeUID);
    }

    function test_StakedAmountAndIsRegistered() public {
        uint256 requiredStake = 2 ether;
        bytes32 uid = _registerContext(requiredStake);

        // Setup: Register a node
        vm.deal(node, requiredStake);
        vm.prank(node);
        core.registerNode{ value: requiredStake }(uid);

        // Verify registered node
        assertTrue(core.isRegistered(uid, node));
        assertEq(core.stakedAmount(uid, node), requiredStake);

        // Verify unregistered stranger
        assertFalse(core.isRegistered(uid, stranger));
        assertEq(core.stakedAmount(uid, stranger), 0);
    }

    function test_ContextExists() public {
        bytes32 uid = _registerContext(0);
        assertTrue(core.contextExists(uid));

        // Should return false for an unregistered context
        bytes32 fakeUID = keccak256("fake.context");
        assertFalse(core.contextExists(fakeUID));
    }
}
