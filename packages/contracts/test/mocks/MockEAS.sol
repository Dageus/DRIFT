// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IEAS } from "../../src/providers/EAS.sol";

contract MockEAS is IEAS {
    mapping(bytes32 => Attestation) public attestations;

    function getAttestation(
        bytes32 uid
    ) external view returns (Attestation memory) {
        return attestations[uid];
    }

    function mockAttestation(
        bytes32 uid,
        Attestation memory a
    ) external {
        attestations[uid] = a;
    }
}
