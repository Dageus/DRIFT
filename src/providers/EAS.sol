// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IAttestationProvider } from "./IAttestationProvider.sol";

/// @dev EAS interface
interface IEAS {
    struct Attestation {
        bytes32 uid;
        bytes32 schema;
        uint64 time;
        uint64 expirationTime;
        uint64 revocationTime;
        bytes32 refUID;
        address recipient;
        address attester;
        bool revocable;
        bytes data;
    }

    function getAttestation(bytes32 uid) external view returns (Attestation memory);
}

/// @title  EASAttestationAdapter
/// @notice Implements IAttestationProvider by wrapping the EAS contract.
///         Translates EAS's native struct into DRIFT's AttestationData.
/// @dev    Immutable — no upgradeability needed. If the EAS address changes,
///         deploy a new adapter and update the source's provider reference in
///         DriftCore. Scoring logic is unaffected.
contract EASAttestationAdapter is IAttestationProvider {
    IEAS public immutable eas;

    constructor(address easAddress) {
        require(easAddress != address(0), "DRIFT: zero EAS address");
        eas = IEAS(easAddress);
    }

    /// @inheritdoc IAttestationProvider
    function providerName() external pure returns (string memory) {
        return "EAS";
    }

    /// @inheritdoc IAttestationProvider
    function isValid(bytes32 uid, bytes32 schemaUID, address subject) external view returns (bool) {
        IEAS.Attestation memory a = eas.getAttestation(uid);

        return
            a.uid != bytes32(0) && // exists
            a.schema == schemaUID && // correct schema
            a.recipient == subject && // correct subject
            a.revocationTime == 0 && // not revoked
            (a.expirationTime == 0 || // not expired
                a.expirationTime > block.timestamp);
    }
}
