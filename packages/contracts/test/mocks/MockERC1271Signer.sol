// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title MockERC1271Signer
/// @notice Minimal ERC-1271 wallet stand-in (e.g. a Safe) for testing settlement authority.
///         Delegates signature validation to a single owner key; a toggle lets tests simulate
///         a wallet that rejects an otherwise well-formed signature (e.g. a revoked/expired one).
contract MockERC1271Signer is IERC1271 {
    bytes4 private constant MAGIC_VALUE = 0x1626ba7e;

    address public immutable owner;
    bool public rejectAll;

    constructor(
        address _owner
    ) {
        owner = _owner;
    }

    function setRejectAll(
        bool _reject
    ) external {
        rejectAll = _reject;
    }

    function isValidSignature(
        bytes32 hash,
        bytes memory signature
    ) external view override returns (bytes4) {
        if (rejectAll) return 0xffffffff;

        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) {
            return MAGIC_VALUE;
        }
        return 0xffffffff;
    }
}
