// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTCore } from "../core/IDRIFTCore.sol";
import { IPolicy, NodeStatus } from "./IPolicy.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title VouchingPolicy
/// @notice Context admission policy gated by endorsements from existing DRIFT members, rather
///         than any external oracle — an applicant is admitted once `requiredVouches` distinct,
///         eligible existing members have signed off on them.
/// @dev Fully immutable configuration (no admin setters), matching EASPolicy's posture: the
///      threshold, per-voucher cap, and required voucher role are fixed at deployment. Vouches are
///      final once redeemed — there is no revocation path, mirroring how attestations elsewhere in
///      DRIFT are dealt with after the fact (ban/slash), not retracted.
contract VouchingPolicy is IPolicy {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    error InsufficientVouches(uint256 provided, uint256 required);
    error ArrayLengthMismatch();
    error ZeroRequiredVouches();
    error ZeroVoucherCap();

    /// @notice The DRIFT registry vouchers' standing is checked against.
    IDRIFTCore public immutable core;
    /// @notice Number of distinct, eligible voucher signatures an applicant needs.
    uint256 public immutable requiredVouches;
    /// @notice Maximum number of applicants a single voucher may ever successfully endorse across
    ///         this policy's lifetime — bounds a compromised or malicious voucher's blast radius.
    uint256 public immutable maxVouchesPerVoucher;
    /// @notice Role a voucher must hold in `contextUID` to be eligible. bytes32(0) means any
    ///         currently-registered (non-banned) node qualifies, regardless of role.
    bytes32 public immutable requiredVoucherRole;

    /// @notice Number of applicants each voucher has successfully endorsed so far.
    mapping(address => uint256) public vouchesUsed;

    /// @param _core DRIFTCore registry used to check voucher standing.
    /// @param _requiredVouches Distinct eligible signatures needed to admit an applicant. Must be
    ///        at least 1 (a policy requiring zero vouches is just an open policy).
    /// @param _maxVouchesPerVoucher Endorsement cap per voucher. Must be at least 1.
    /// @param _requiredVoucherRole Role vouchers must hold, or bytes32(0) for "any registered node".
    constructor(
        address _core,
        uint256 _requiredVouches,
        uint256 _maxVouchesPerVoucher,
        bytes32 _requiredVoucherRole
    ) {
        if (_requiredVouches == 0) revert ZeroRequiredVouches();
        if (_maxVouchesPerVoucher == 0) revert ZeroVoucherCap();

        core = IDRIFTCore(_core);
        requiredVouches = _requiredVouches;
        maxVouchesPerVoucher = _maxVouchesPerVoucher;
        requiredVoucherRole = _requiredVoucherRole;
    }

    /// @inheritdoc IPolicy
    /// @param entryProof abi.encode(address[] vouchers, bytes[] signatures) — parallel arrays,
    ///        one 65-byte ECDSA signature per voucher over
    ///        keccak256(abi.encode(address(this), contextUID, node)), personal_sign-prefixed.
    ///        Signatures beyond `requiredVouches` valid, eligible, distinct ones are accepted but
    ///        ignored — only the vouchers actually needed to reach the threshold have their cap
    ///        charged, so an applicant collecting extra signatures "just in case" doesn't burn
    ///        capacity those vouchers never had to spend.
    function evaluate(
        address node,
        bytes32 contextUID,
        bytes calldata entryProof
    ) external returns (NodeStatus) {
        (address[] memory vouchers, bytes[] memory signatures) =
            abi.decode(entryProof, (address[], bytes[]));
        if (vouchers.length != signatures.length) revert ArrayLengthMismatch();

        bytes32 digest =
            keccak256(abi.encode(address(this), contextUID, node)).toEthSignedMessageHash();

        address[] memory charged = new address[](requiredVouches);
        uint256 validCount = 0;

        for (uint256 i = 0; i < vouchers.length && validCount < requiredVouches; i++) {
            address voucher = vouchers[i];

            // Signature must actually be from the claimed voucher.
            if (digest.recover(signatures[i]) != voucher) continue;

            // Reject a voucher already counted earlier in this same submission.
            bool duplicate = false;
            for (uint256 j = 0; j < validCount; j++) {
                if (charged[j] == voucher) {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate) continue;

            if (!_isEligibleVoucher(contextUID, voucher)) continue;
            if (vouchesUsed[voucher] >= maxVouchesPerVoucher) continue;

            charged[validCount] = voucher;
            validCount++;
        }

        if (validCount < requiredVouches) {
            revert InsufficientVouches(validCount, requiredVouches);
        }

        // Only now, having confirmed the applicant clears the bar, actually spend the vouchers'
        // capacity — a failed application must never partially consume anyone's cap.
        for (uint256 i = 0; i < requiredVouches; i++) {
            vouchesUsed[charged[i]]++;
        }

        return NodeStatus.FULL;
    }

    /// @dev No explicit self-vouch guard is needed: DRIFTCore.registerNode only ever calls
    ///      evaluate() for a `node` that is NOT YET registered in `contextUID` (it already reverts
    ///      NodeAlreadyRegistered before reaching the policy otherwise), so `node` can never itself
    ///      pass the isRegistered check below — a self-signed "voucher" entry is automatically
    ///      rejected as ineligible, the same as any other invalid entry.
    function _isEligibleVoucher(
        bytes32 contextUID,
        address voucher
    ) internal view returns (bool) {
        if (!core.isRegistered(contextUID, voucher)) return false;
        if (requiredVoucherRole == bytes32(0)) return true;
        return core.hasNodeRole(contextUID, voucher, requiredVoucherRole);
    }
}
