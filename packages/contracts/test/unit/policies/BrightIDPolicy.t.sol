// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTCore } from "../../../src/core/DRIFTCore.sol";
import { BrightIDPolicy } from "../../../src/policies/BrightIDPolicy.sol";
import { NodeStatus } from "../../../src/policies/IPolicy.sol";
import { DRIFTToken } from "../../../src/token/DRIFTToken.sol";
import { MockBrightID } from "../../mocks/MockBrightID.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "forge-std/Test.sol";

contract BrightIDPolicyTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    MockBrightID public mockBrightID;
    BrightIDPolicy public policy;

    address public admin = makeAddr("admin");
    address public verifiedUser = makeAddr("verifiedUser");
    address public unverifiedUser = makeAddr("unverifiedUser");
    bytes32 public contextUID;

    function setUp() public {
        DRIFTCore implementation = new DRIFTCore();
        bytes memory initData = abi.encodeWithSelector(DRIFTCore.initialize.selector, admin);
        core = DRIFTCore(address(new ERC1967Proxy(address(implementation), initData)));
        driftToken = new DRIFTToken(address(core));

        vm.prank(admin);
        core.setDriftToken(address(driftToken));

        vm.prank(admin);
        contextUID = core.registerContext("brightid.test");

        mockBrightID = new MockBrightID();
        policy = new BrightIDPolicy(address(mockBrightID));

        vm.prank(admin);
        core.setContextPolicy(contextUID, address(policy));
    }

    function test_EvaluateReturnsFullForVerifiedUser() public {
        mockBrightID.setVerified(verifiedUser, true);

        vm.prank(verifiedUser);
        core.registerNode(contextUID, "0x");

        assertEq(uint256(core.nodeStatus(contextUID, verifiedUser)), uint256(NodeStatus.FULL));
    }

    function test_RevertIf_UserNotVerified() public {
        vm.prank(unverifiedUser);
        vm.expectRevert(
            abi.encodeWithSelector(BrightIDPolicy.NotBrightIDVerified.selector, unverifiedUser)
        );
        core.registerNode(contextUID, "0x");
    }

    /// @notice entryProof is unused — verification state is looked up purely by address, so
    ///         garbage/empty proof data must not affect the outcome either way.
    function test_EntryProofContentIsIgnored() public {
        mockBrightID.setVerified(verifiedUser, true);

        vm.prank(verifiedUser);
        core.registerNode(contextUID, hex"deadbeef");

        assertEq(uint256(core.nodeStatus(contextUID, verifiedUser)), uint256(NodeStatus.FULL));
    }
}
