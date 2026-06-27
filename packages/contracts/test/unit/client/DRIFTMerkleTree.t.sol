// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "forge-std/Test.sol";

contract DRIFTMerkleTreeTest is Test {
    // Hardcoded constants for deterministic cross-language hashing
    bytes32 constant CONTEXT_UID = bytes32(uint256(1));
    bytes32 constant PROFESSOR_ROLE = keccak256("PROFESSOR_ROLE");
    address constant NODE_1 = address(0x0A);
    address constant NODE_2 = address(0x0B);

    // === VERIFICATION ============================================================

    /// @notice Ensures solidity Merkle verification correctly aligns with external TS script generation
    function test_StandardMerkleAlignment() public pure {
        // Expected outputs derived from off-chain TS script
        bytes32 expectedRoot = 0x148b9bf8a1cc9f9c45333f1014e3679020464cb87576e40bdbb13b4ba2df2a13;
        bytes32 siblingHash = 0x8682cb023d9db73385f283ed58e94c2470937d3e881fe9e963c70f22c98fff99;

        bytes32 leaf = keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        CONTEXT_UID,
                        NODE_1,
                        PROFESSOR_ROLE,
                        uint256(100), // Score
                        uint256(1) // Epoch
                    )
                )
            )
        );

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = siblingHash;

        assertTrue(MerkleProof.verify(proof, expectedRoot, leaf), "OZ Tree Alignment Failed");
    }
}
