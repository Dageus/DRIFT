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
    /// @param  uid       Attestation UID to validate.
    /// @param  schemaUID Expected schema UID.
    /// @param  subject   Expected recipient/subject address.
    /// @return           True if all conditions are met.
    function isValid(bytes32 uid, bytes32 schemaUID, address subject) external view returns (bool);
}
