// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
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
    bytes32 public contextUID;
    uint256 public settlerPk = 0x1234;
    address public settler = vm.addr(settlerPk);

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
        contextUID = core.registerContext("test.university");
        core.grantRole(core.FACTORY_ROLE(), address(factory));
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
            0,
            "EigenTrust",
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
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("DRIFT_WeightedGovernance")),
                keccak256(bytes("1")),
                block.chainid,
                address(client)
            )
        );

        // Hash the Settlement Payload and Sign it
        bytes32 structHash = keccak256(
            abi.encode(client.SETTLE_TYPEHASH(), contextUID, node, ROLE_PROFESSOR, rewardAmount, 0)
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Submit the cryptographically valid proof to the client
        client.settleReputation(node, ROLE_PROFESSOR, rewardAmount, 0, sig);

        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, ROLE_PROFESSOR)));
        assertEq(driftToken.balanceOf(node, tokenId), rewardAmount);
    }
}
