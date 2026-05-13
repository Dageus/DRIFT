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

    uint256 public adminKey;
    address public admin;

    address public node = makeAddr("node");
    address public stranger = makeAddr("stranger");

    uint256 public settlerKey;
    address public settler;

    bytes32 constant CONTEXT_NAME_HASH = keccak256("test.university");
    bytes32 constant ROLE_STUDENT = keccak256("STUDENT");
    bytes32 constant ROLE_PROFESSOR = keccak256("PROFESSOR");

    bytes32 public contextUID;

    function setUp() public {
        adminKey = uint256(keccak256("admin.key"));
        admin = vm.addr(adminKey);

        DRIFTCore coreImpl = new DRIFTCore();
        bytes memory coreInit = abi.encodeWithSelector(DRIFTCore.initialize.selector, admin);
        core = DRIFTCore(address(new ERC1967Proxy(address(coreImpl), coreInit)));

        driftToken = new DRIFTToken(address(core));
        vm.prank(admin);
        core.setDriftToken(address(driftToken));

        settlerKey = uint256(keccak256("drift.settler.key"));
        settler = vm.addr(settlerKey);

        WeightedGovernanceClient template = new WeightedGovernanceClient();
        factory = new DRIFTClientFactory(address(core));

        vm.startPrank(admin);
        core.grantRole(core.CLIENT_ROLE(), address(factory));
        core.grantRole(core.CLIENT_ROLE(), admin);
        contextUID = core.registerContext("test.university");
        vm.stopPrank();

        bytes32[] memory roles = new bytes32[](2);
        roles[0] = ROLE_STUDENT;
        roles[1] = ROLE_PROFESSOR;

        uint256[] memory weights = new uint256[](2);
        weights[0] = 1; // Student = 1x power
        weights[1] = 5; // Professor = 5x power

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            settler,
            roles,
            weights
        );

        vm.prank(admin);
        address cloneAddr = factory.deployClient(
            contextUID,
            address(template),
            initData,
            bytes32("weighted_test_salt")
        );
        client = WeightedGovernanceClient(cloneAddr);

        bytes32 adminRole = core.contextAdminRole(contextUID);

        vm.prank(admin);
        core.grantRole(adminRole, address(client));
    }

    // EIP-712 Signature Helper ================================================

    function _signSettle(
        uint256 privateKey,
        bytes32 _contextUID,
        address _node,
        bytes32 _role,
        uint256 _score,
        uint256 _epoch
    ) internal view returns (bytes memory) {
        bytes32 DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("DRIFT_WeightedGovernance")),
                keccak256(bytes("1")),
                block.chainid,
                address(client)
            )
        );

        bytes32 structHash = keccak256(abi.encode(client.SETTLE_TYPEHASH(), _contextUID, _node, _role, _score, _epoch));

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // Tests ===================================================================

    function test_InitializationSetsWeights() public view {
        assertEq(client.roleWeights(ROLE_STUDENT), 1);
        assertEq(client.roleWeights(ROLE_PROFESSOR), 5);
        assertEq(client.trustedSettler(), settler);
    }

    function test_SettleReputationMintsERC1155() public {
        vm.prank(node);
        core.registerNode(contextUID);

        // mocking the SDK operations
        uint256 rewardAmount = 50;
        uint256 epoch = 1;
        bytes memory sig = _signSettle(settlerKey, contextUID, node, ROLE_PROFESSOR, rewardAmount, epoch);

        client.settleReputation(node, ROLE_PROFESSOR, rewardAmount, epoch, sig);

        // Verify the ERC-1155 tokens
        uint256 expectedTokenId = uint256(keccak256(abi.encode(contextUID, ROLE_PROFESSOR)));
        assertEq(driftToken.balanceOf(node, expectedTokenId), rewardAmount);
    }

    function test_GovernanceVotingPowerCalculatesCorrectly() public {
        vm.startPrank(node);
        core.registerNode(contextUID);
        vm.stopPrank();

        // 10 Student rep and 10 Professor rep
        bytes memory sig1 = _signSettle(settlerKey, contextUID, node, ROLE_STUDENT, 10, 1);
        client.settleReputation(node, ROLE_STUDENT, 10, 1, sig1);

        bytes memory sig2 = _signSettle(settlerKey, contextUID, node, ROLE_PROFESSOR, 10, 2);
        client.settleReputation(node, ROLE_PROFESSOR, 10, 2, sig2);

        // (10 * 1) + (10 * 5) = 60
        uint256 power = client.getVotingPower(node);
        assertEq(power, 60);
    }

    function test_GovernanceCreateAndExecuteProposal() public {
        bytes32 newSchema = keccak256("test.new.schema");
        address target = address(core);
        bytes memory payload = abi.encodeWithSelector(
            DRIFTCore.addSchema.selector,
            contextUID,
            newSchema,
            makeAddr("adapter")
        );

        vm.prank(admin);
        uint256 pId = client.createProposal("Add Schema", target, payload, 3); // 3 days

        vm.prank(node);
        core.registerNode(contextUID);
        bytes memory sig = _signSettle(settlerKey, contextUID, node, ROLE_PROFESSOR, 100, 1);
        client.settleReputation(node, ROLE_PROFESSOR, 100, 1, sig);

        // Node votes for the proposal
        vm.prank(node);
        client.castVote(pId, true);

        vm.warp(block.timestamp + 4 days);

        client.executeProposal(pId);

        assertEq(core.getAdapter(contextUID, newSchema), makeAddr("adapter"));
    }
}
