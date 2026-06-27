// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IEAS } from "../interfaces/IEAS.sol";
import { IAttestationProvider } from "./IAttestationProvider.sol";

/// @title  EASAdapter
/// @notice Implements IAttestationProvider by wrapping the EAS contract.
///         Translates EAS's native struct into DRIFT's AttestationData.
/// @dev    Immutable — no upgradeability needed. If the EAS address changes,
///         deploy a new adapter and update the source's provider reference in
///         DriftCore. Scoring logic is unaffected.
contract EASAdapter is IAttestationProvider {
    /// @notice Error thrown when the EAS address is zero.
    error ZeroEASAddress();

    /// @notice The underlying EAS contract interface.
    IEAS public immutable eas;

    /// @notice Initializes the adapter with the EAS contract.
    /// @param easAddress The address of the deployed EAS contract.
    constructor(
        address easAddress
    ) {
        if (easAddress == address(0)) revert ZeroEASAddress();
        eas = IEAS(easAddress);
    }

    /// @inheritdoc IAttestationProvider
    function providerName() external pure returns (string memory) {
        return "EAS";
    }

    /// @inheritdoc IAttestationProvider
    function isValid(
        bytes32 uid,
        bytes32 schemaUID,
        address subject
    ) external view returns (bool) {
        IEAS.Attestation memory a = eas.getAttestation(uid);

        return a.uid != bytes32(0) // exists
            && a.schema == schemaUID // correct schema
            && a.recipient == subject // correct subject
            && a.revocationTime == 0 // not revoked
            && (a.expirationTime == 0 // not expired
                || a.expirationTime > block.timestamp);
    }
}
