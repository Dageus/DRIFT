// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { IDRIFTCore } from "../../src/core/IDRIFTCore.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { IDRIFTToken } from "../../src/token/IDRIFTToken.sol";
import { DRIFTClientFactory } from "../../src/client/DRIFTClientFactory.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";
import { NodeStatus } from "../../src/policies/IPolicy.sol";

contract DRIFTSecurityTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public client;

    address public admin = makeAddr("admin");
    address public node = makeAddr("node");

    uint256 public settlerPk = 0x1234;
    address public settler = vm.addr(settlerPk);

    bytes32 public contextUID;
    bytes32 constant ROLE_PROFESSOR = keccak256("PROFESSOR");

    // SETUP ===================================================================

    function setUp() public {
        DRIFTCore coreImpl = new DRIFTCore();
        core = DRIFTCore(
            address(new ERC1967Proxy(address(coreImpl), abi.encodeWithSelector(DRIFTCore.initialize.selector, admin)))
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
        roles[0] = ROLE_PROFESSOR;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            settler,
            0,
            "EigenTrust",
            roles,
            weights
        );

        address cloneAddr = factory.deployClient(contextUID, address(template), initData, bytes32("salt"));
        client = WeightedGovernanceClient(cloneAddr);
        core.grantRole(core.contextAdminRole(contextUID), address(client));
        vm.stopPrank();

        vm.prank(node);
        core.registerNode(contextUID, "0x");
    }

    // TOKEN SECURITY ==========================================================

    /// @notice Ensures that reputation tokens cannot be transferred between users
    function test_TransferReverts() public {
        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), admin);
        core.setContextClient(contextUID, admin);
        core.reward(contextUID, ROLE_PROFESSOR, node, 50);
        core.setContextClient(contextUID, address(client));
        vm.stopPrank();

        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, ROLE_PROFESSOR)));

        vm.prank(node);
        vm.expectRevert(IDRIFTToken.NonTransmissibleToken.selector);
        driftToken.safeTransferFrom(node, makeAddr("stranger"), tokenId, 1, "");
    }

    // NODE STATUS SECURITY ====================================================

    /// @notice Ensures a node marked as BANNED cannot bypass the ban by deregistering
    function test_BannedNodeCannotDeregister() public {
        vm.prank(admin);
        core.setNodeStatus(contextUID, node, NodeStatus.BANNED);

        vm.prank(node);
        vm.expectRevert(IDRIFTCore.BannedNodeCannotDeregister.selector);
        core.deregisterNode(contextUID);
    }

    // ACCESS CONTROL ==========================================================

    /// @notice Ensures only addresses with the FACTORY_ROLE can map clients to contexts
    function test_NonFactoryCannotSetClient() public {
        bytes32 factoryRole = core.FACTORY_ROLE();

        vm.prank(node);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, node, factoryRole)
        );
        core.setContextClient(contextUID, address(this));
    }
}
