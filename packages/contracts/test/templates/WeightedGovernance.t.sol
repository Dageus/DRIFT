// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { DRIFTClientFactory } from "../../src/client/DRIFTClientFactory.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";

contract WeightedGovernanceClientTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public client;

    address public admin = makeAddr("admin");
    address public node = makeAddr("node");
    address public settler = makeAddr("settler");
    bytes32 public contextUID;

    bytes32 constant ROLE_STUDENT = keccak256("STUDENT");
    bytes32 constant ROLE_PROFESSOR = keccak256("PROFESSOR");

    function setUp() public {
        DRIFTCore coreImpl = new DRIFTCore();
        bytes memory coreInit = abi.encodeWithSelector(DRIFTCore.initialize.selector, admin);
        core = DRIFTCore(address(new ERC1967Proxy(address(coreImpl), coreInit)));

        driftToken = new DRIFTToken(address(core));
        vm.prank(admin);
        core.setDriftToken(address(driftToken));

        WeightedGovernanceClient template = new WeightedGovernanceClient();
        factory = new DRIFTClientFactory(address(core));

        vm.startPrank(admin);
        contextUID = core.registerContext("test.university", ""); // reputation algorithms aren't important here
        vm.stopPrank();

        bytes32[] memory roles = new bytes32[](2);
        roles[0] = ROLE_STUDENT;
        roles[1] = ROLE_PROFESSOR;
        uint256[] memory weights = new uint256[](2);
        weights[0] = 1;
        weights[1] = 5;

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            settler,
            roles,
            weights
        );

        bytes32 adminRole = core.contextAdminRole(contextUID);
        vm.startPrank(admin);
        core.grantRole(adminRole, admin);
        address cloneAddr = factory.deployClient(contextUID, address(template), initData, bytes32("salt"));
        client = WeightedGovernanceClient(cloneAddr);
        core.grantRole(adminRole, address(client));
        vm.stopPrank();
    }

    function _signSettle(
        address _node,
        bytes32 _role,
        uint256 _score,
        uint256 _epoch
    ) internal pure returns (bytes memory) {
        // Simple mock signature helper
        return abi.encodePacked(_node, _role, _score, _epoch);
    }

    function test_InitializationSetsWeights() public view {
        assertEq(client.roleWeights(ROLE_STUDENT), 1);
        assertEq(client.roleWeights(ROLE_PROFESSOR), 5);
        assertEq(client.trustedSettler(), settler);
    }

    function test_SettleReputationMintsERC1155() public {
        vm.prank(node);
        core.registerNode(contextUID, "0x");

        uint256 rewardAmount = 50;
        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, ROLE_PROFESSOR)));

        vm.prank(admin);
        core.reward(contextUID, ROLE_PROFESSOR, node, rewardAmount);
        assertEq(driftToken.balanceOf(node, tokenId), rewardAmount);
    }
}
