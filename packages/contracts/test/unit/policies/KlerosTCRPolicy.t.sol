// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTCore } from "../../../src/core/DRIFTCore.sol";
import { NodeStatus } from "../../../src/policies/IPolicy.sol";
import { IKlerosGTCR, KlerosTCRPolicy } from "../../../src/policies/KlerosTCRPolicy.sol";
import { DRIFTToken } from "../../../src/token/DRIFTToken.sol";
import { MockKlerosGTCR } from "../../mocks/MockKlerosGTCR.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "forge-std/Test.sol";

contract KlerosTCRPolicyTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    MockKlerosGTCR public mockTcr;
    KlerosTCRPolicy public policy;

    address public admin = makeAddr("admin");
    address public listedUser = makeAddr("listedUser");
    address public unlistedUser = makeAddr("unlistedUser");
    bytes32 public contextUID;

    function setUp() public {
        DRIFTCore implementation = new DRIFTCore();
        bytes memory initData = abi.encodeWithSelector(DRIFTCore.initialize.selector, admin);
        core = DRIFTCore(address(new ERC1967Proxy(address(implementation), initData)));
        driftToken = new DRIFTToken(address(core));

        vm.prank(admin);
        core.setDriftToken(address(driftToken));

        vm.prank(admin);
        contextUID = core.registerContext("kleros.test");

        mockTcr = new MockKlerosGTCR();
        policy = new KlerosTCRPolicy(address(mockTcr));

        vm.prank(admin);
        core.setContextPolicy(contextUID, address(policy));
    }

    function _itemID(
        address node
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(node));
    }

    function test_EvaluateReturnsFullForRegisteredItem() public {
        mockTcr.setStatus(_itemID(listedUser), IKlerosGTCR.Status.Registered);

        vm.prank(listedUser);
        core.registerNode(contextUID, "0x");

        assertEq(uint256(core.nodeStatus(contextUID, listedUser)), uint256(NodeStatus.FULL));
    }

    function test_RevertIf_ItemAbsent() public {
        // Default MockKlerosGTCR state for any never-set item is Status.Absent.
        vm.prank(unlistedUser);
        vm.expectRevert(
            abi.encodeWithSelector(KlerosTCRPolicy.NotOnKlerosRegistry.selector, unlistedUser)
        );
        core.registerNode(contextUID, "0x");
    }

    function test_RevertIf_ItemOnlyRegistrationRequested() public {
        // A pending (not yet resolved) submission must not count as admitted.
        mockTcr.setStatus(_itemID(unlistedUser), IKlerosGTCR.Status.RegistrationRequested);

        vm.prank(unlistedUser);
        vm.expectRevert(
            abi.encodeWithSelector(KlerosTCRPolicy.NotOnKlerosRegistry.selector, unlistedUser)
        );
        core.registerNode(contextUID, "0x");
    }

    function test_RevertIf_ItemClearingRequested() public {
        // Registered but with a pending removal request — still resolves as ineligible, matching
        // the strict "== Registered" check rather than "!= Absent".
        mockTcr.setStatus(_itemID(unlistedUser), IKlerosGTCR.Status.ClearingRequested);

        vm.prank(unlistedUser);
        vm.expectRevert(
            abi.encodeWithSelector(KlerosTCRPolicy.NotOnKlerosRegistry.selector, unlistedUser)
        );
        core.registerNode(contextUID, "0x");
    }
}
