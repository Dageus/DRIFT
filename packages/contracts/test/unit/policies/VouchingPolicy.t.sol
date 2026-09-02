// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTCore } from "../../../src/core/DRIFTCore.sol";
import { NodeStatus } from "../../../src/policies/IPolicy.sol";
import { VouchingPolicy } from "../../../src/policies/VouchingPolicy.sol";
import { DRIFTToken } from "../../../src/token/DRIFTToken.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "forge-std/Test.sol";

contract VouchingPolicyTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    VouchingPolicy public policy;

    address public admin = makeAddr("admin");
    address public applicant = makeAddr("applicant");
    bytes32 public contextUID;

    bytes32 constant VOUCHER_ROLE = keccak256("VOUCHER");

    uint256 constant REQUIRED_VOUCHES = 2;
    uint256 constant MAX_VOUCHES_PER_VOUCHER = 1;

    // Private keys so vouchers can actually sign — makeAddr() alone gives no key to sign with.
    uint256 constant PK_A = 0xA11CE;
    uint256 constant PK_B = 0xB0B;
    uint256 constant PK_C = 0xCAFE;
    address voucherA = vm.addr(PK_A);
    address voucherB = vm.addr(PK_B);
    address voucherC = vm.addr(PK_C);

    function setUp() public {
        DRIFTCore implementation = new DRIFTCore();
        bytes memory initData = abi.encodeWithSelector(DRIFTCore.initialize.selector, admin);
        core = DRIFTCore(address(new ERC1967Proxy(address(implementation), initData)));
        driftToken = new DRIFTToken(address(core));

        vm.prank(admin);
        core.setDriftToken(address(driftToken));

        vm.prank(admin);
        contextUID = core.registerContext("vouching.test");

        // Vouchers register while the context is still open (no policy set yet) — the policy only
        // needs to gate the *applicant's* registerNode call below, not the vouchers' own.
        vm.prank(voucherA);
        core.registerNode(contextUID, "0x");
        vm.prank(voucherB);
        core.registerNode(contextUID, "0x");
        vm.prank(voucherC);
        core.registerNode(contextUID, "0x");

        policy = new VouchingPolicy(
            address(core), REQUIRED_VOUCHES, MAX_VOUCHES_PER_VOUCHER, bytes32(0)
        );

        vm.prank(admin);
        core.setContextPolicy(contextUID, address(policy));
    }

    // HELPERS =================================================================

    function _sign(
        uint256 pk,
        address node
    ) internal view returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(address(policy), contextUID, node))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _proof(
        address[] memory vouchers,
        bytes[] memory sigs
    ) internal pure returns (bytes memory) {
        return abi.encode(vouchers, sigs);
    }

    // EVALUATE =================================================================

    function test_EvaluateSucceedsWithSufficientEligibleVouches() public {
        address[] memory vouchers = new address[](2);
        vouchers[0] = voucherA;
        vouchers[1] = voucherB;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(PK_A, applicant);
        sigs[1] = _sign(PK_B, applicant);

        vm.prank(applicant);
        core.registerNode(contextUID, _proof(vouchers, sigs));

        assertEq(uint256(core.nodeStatus(contextUID, applicant)), uint256(NodeStatus.FULL));
        assertEq(policy.vouchesUsed(voucherA), 1);
        assertEq(policy.vouchesUsed(voucherB), 1);
    }

    function test_RevertIf_InsufficientVouches() public {
        address[] memory vouchers = new address[](1);
        vouchers[0] = voucherA;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(PK_A, applicant);

        vm.prank(applicant);
        vm.expectRevert(
            abi.encodeWithSelector(VouchingPolicy.InsufficientVouches.selector, 1, REQUIRED_VOUCHES)
        );
        core.registerNode(contextUID, _proof(vouchers, sigs));
    }

    function test_IgnoresDuplicateVoucherSignatures() public {
        // Same voucher's valid signature submitted twice — must not count as two distinct vouches.
        address[] memory vouchers = new address[](2);
        vouchers[0] = voucherA;
        vouchers[1] = voucherA;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(PK_A, applicant);
        sigs[1] = _sign(PK_A, applicant);

        vm.prank(applicant);
        vm.expectRevert(
            abi.encodeWithSelector(VouchingPolicy.InsufficientVouches.selector, 1, REQUIRED_VOUCHES)
        );
        core.registerNode(contextUID, _proof(vouchers, sigs));
    }

    function test_IgnoresSignatureFromUnregisteredAddress() public {
        uint256 pkStranger = 0xD00D;
        address stranger = vm.addr(pkStranger); // never registered in contextUID

        address[] memory vouchers = new address[](2);
        vouchers[0] = voucherA;
        vouchers[1] = stranger;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(PK_A, applicant);
        sigs[1] = _sign(pkStranger, applicant);

        vm.prank(applicant);
        vm.expectRevert(
            abi.encodeWithSelector(VouchingPolicy.InsufficientVouches.selector, 1, REQUIRED_VOUCHES)
        );
        core.registerNode(contextUID, _proof(vouchers, sigs));
    }

    function test_IgnoresBannedVoucher() public {
        vm.prank(admin);
        core.setNodeStatus(contextUID, voucherB, NodeStatus.BANNED);

        address[] memory vouchers = new address[](2);
        vouchers[0] = voucherA;
        vouchers[1] = voucherB;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(PK_A, applicant);
        sigs[1] = _sign(PK_B, applicant);

        vm.prank(applicant);
        vm.expectRevert(
            abi.encodeWithSelector(VouchingPolicy.InsufficientVouches.selector, 1, REQUIRED_VOUCHES)
        );
        core.registerNode(contextUID, _proof(vouchers, sigs));
    }

    function test_IgnoresMismatchedSignature() public {
        // sigs[1] is voucherA's signature, but claimed as voucherB's — recover() won't match.
        address[] memory vouchers = new address[](2);
        vouchers[0] = voucherA;
        vouchers[1] = voucherB;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(PK_A, applicant);
        sigs[1] = _sign(PK_A, applicant);

        vm.prank(applicant);
        vm.expectRevert(
            abi.encodeWithSelector(VouchingPolicy.InsufficientVouches.selector, 1, REQUIRED_VOUCHES)
        );
        core.registerNode(contextUID, _proof(vouchers, sigs));
    }

    /// @notice A voucher's endorsement is only ever spent by an application that actually reaches
    ///         threshold — a failed application must not partially consume anyone's cap.
    function test_FailedApplicationDoesNotConsumeVoucherCap() public {
        address[] memory vouchers = new address[](1);
        vouchers[0] = voucherA;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(PK_A, applicant);

        vm.prank(applicant);
        vm.expectRevert(
            abi.encodeWithSelector(VouchingPolicy.InsufficientVouches.selector, 1, REQUIRED_VOUCHES)
        );
        core.registerNode(contextUID, _proof(vouchers, sigs));

        assertEq(policy.vouchesUsed(voucherA), 0);
    }

    function test_RevertIf_VoucherCapExhausted() public {
        address applicant2 = makeAddr("applicant2");

        // voucherA endorses `applicant` alone with voucherB's help — uses up voucherA's cap of 1.
        address[] memory vouchers = new address[](2);
        vouchers[0] = voucherA;
        vouchers[1] = voucherB;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(PK_A, applicant);
        sigs[1] = _sign(PK_B, applicant);
        vm.prank(applicant);
        core.registerNode(contextUID, _proof(vouchers, sigs));
        assertEq(policy.vouchesUsed(voucherA), MAX_VOUCHES_PER_VOUCHER);

        // voucherA tries to endorse a second applicant — cap already exhausted, so voucherC must
        // carry the second slot instead, or the application fails.
        address[] memory vouchers2 = new address[](2);
        vouchers2[0] = voucherA;
        vouchers2[1] = voucherC;
        bytes[] memory sigs2 = new bytes[](2);
        sigs2[0] = _sign(PK_A, applicant2);
        sigs2[1] = _sign(PK_C, applicant2);

        // voucherC alone isn't enough (threshold is 2, voucherA's signature is ignored as
        // cap-exhausted), so this must fail.
        address[] memory onlyC = new address[](1);
        onlyC[0] = voucherC;
        bytes[] memory onlyCSig = new bytes[](1);
        onlyCSig[0] = _sign(PK_C, applicant2);
        vm.prank(applicant2);
        vm.expectRevert(
            abi.encodeWithSelector(VouchingPolicy.InsufficientVouches.selector, 1, REQUIRED_VOUCHES)
        );
        core.registerNode(contextUID, _proof(onlyC, onlyCSig));
    }

    function test_ExtraValidSignaturesBeyondThresholdAreNotCharged() public {
        // Three valid, eligible signatures submitted; threshold is 2 — only the first two
        // encountered should have their cap charged, the third left untouched.
        address[] memory vouchers = new address[](3);
        vouchers[0] = voucherA;
        vouchers[1] = voucherB;
        vouchers[2] = voucherC;
        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _sign(PK_A, applicant);
        sigs[1] = _sign(PK_B, applicant);
        sigs[2] = _sign(PK_C, applicant);

        vm.prank(applicant);
        core.registerNode(contextUID, _proof(vouchers, sigs));

        assertEq(policy.vouchesUsed(voucherA), 1);
        assertEq(policy.vouchesUsed(voucherB), 1);
        assertEq(policy.vouchesUsed(voucherC), 0);
    }

    function test_RequiredVoucherRoleGatesEligibility() public {
        VouchingPolicy roleGatedPolicy =
            new VouchingPolicy(address(core), 1, MAX_VOUCHES_PER_VOUCHER, VOUCHER_ROLE);

        vm.prank(admin);
        bytes32 uid2 = core.registerContext("vouching.role.test");

        // voucherA registers while the context is still open, before the policy is attached.
        vm.prank(voucherA);
        core.registerNode(uid2, "0x");

        vm.prank(admin);
        core.setContextPolicy(uid2, address(roleGatedPolicy));

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(address(roleGatedPolicy), uid2, applicant))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK_A, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        address[] memory vouchers = new address[](1);
        vouchers[0] = voucherA;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = sig;

        // voucherA is registered but doesn't hold VOUCHER_ROLE yet — must fail.
        vm.prank(applicant);
        vm.expectRevert(abi.encodeWithSelector(VouchingPolicy.InsufficientVouches.selector, 0, 1));
        core.registerNode(uid2, abi.encode(vouchers, sigs));

        // Grant the role via a client — assignRole is onlyContextClient.
        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), admin);
        core.setContextClient(uid2, admin, admin);
        core.assignRole(uid2, voucherA, VOUCHER_ROLE);
        vm.stopPrank();

        vm.prank(applicant);
        core.registerNode(uid2, abi.encode(vouchers, sigs));
        assertEq(uint256(core.nodeStatus(uid2, applicant)), uint256(NodeStatus.FULL));
    }

    // CONSTRUCTOR ==============================================================

    function test_RevertIf_ConstructedWithZeroRequiredVouches() public {
        vm.expectRevert(VouchingPolicy.ZeroRequiredVouches.selector);
        new VouchingPolicy(address(core), 0, 1, bytes32(0));
    }

    function test_RevertIf_ConstructedWithZeroVoucherCap() public {
        vm.expectRevert(VouchingPolicy.ZeroVoucherCap.selector);
        new VouchingPolicy(address(core), 1, 0, bytes32(0));
    }
}
