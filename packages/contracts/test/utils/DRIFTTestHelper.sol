// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title DRIFTTestHelper
/// @notice Centralized cryptographic and utility functions for the DRIFT test suite
abstract contract DRIFTTestHelper is Test {
    /// @notice Generates a valid EIP-712 signature for settling an epoch root
    function _signEpochRoot(
        uint256 pk,
        bytes32 contextUID,
        uint256 epoch,
        bytes32 root,
        address verifyingContract
    ) internal view returns (bytes memory) {
        bytes32 settleRootTypehash = keccak256("SettleRoot(bytes32 contextUID,uint256 epoch,bytes32 merkleRoot)");

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("DRIFT_WeightedGovernance")),
                keccak256(bytes("1")),
                block.chainid,
                verifyingContract
            )
        );

        bytes32 structHash = keccak256(abi.encode(settleRootTypehash, contextUID, epoch, root));
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        return abi.encodePacked(r, s, v);
    }

    /// @notice Safely pairs and hashes two Merkle leaves per OpenZeppelin specifications
    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
