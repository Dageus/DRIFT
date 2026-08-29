// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTTypes } from "../Common.sol";

/// @title  IAttestationProvider
/// @notice Abstraction over any attestation backend (EAS, custom, etc).
///         DRIFT never imports a provider directly — only this interface.
/// @dev    Attestation UIDs are provided externally (by the SDK or off-chain
///         indexer) since on-chain enumeration is not feasible at scale.
interface IAttestationProvider {
    /// @notice Human-readable provider identifier. Used for logging.
    /// @return name e.g. "EAS-Ethereum", "EAS-Arbitrum", "CustomProvider"
    function providerName() external view returns (string memory);

    /// @notice Check if an attestation is valid:
    ///         - exists in the provider
    ///         - matches the expected schema
    ///         - was made about the expected subject
    ///         - is not revoked
    ///         - is not expired
    ///         - was made at or after both parties' most recent join time in the context (so
    ///           leaving and rejoining doesn't carry over attestation history from before)
    /// @param  uid              Attestation UID to validate.
    /// @param  schemaUID        Expected schema UID.
    /// @param  subject          Expected recipient/subject address.
    /// @param  subjectJoinedAt  DRIFTCore.nodeRegisteredAt(contextUID, subject) — unix timestamp.
    /// @param  attesterJoinedAt DRIFTCore.nodeRegisteredAt(contextUID, attester) — unix timestamp.
    /// @return                  True if all conditions are met.
    function isValid(
        bytes32 uid,
        bytes32 schemaUID,
        address subject,
        uint256 subjectJoinedAt,
        uint256 attesterJoinedAt
    ) external view returns (bool);
}
