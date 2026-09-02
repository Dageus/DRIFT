// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IEAS } from "../interfaces/IEAS.sol";
import { IPolicy, NodeStatus } from "./IPolicy.sol";

/// @title EASPolicy
/// @notice Context admission policy that verifies a specific EAS attestation.
contract EASPolicy is IPolicy {
    error AttestationNotFound();
    error InvalidSchema();
    error InvalidIssuer();
    error InvalidRecipient();
    error AttestationRevoked();

    /// @notice The EAS contract used for fetching attestations.
    IEAS public immutable eas;
    /// @notice The schema UID that the attestation must follow.
    bytes32 public immutable requiredSchema;
    /// @notice The authorized address that must have issued the attestation.
    address public immutable trustedIssuer;

    /// @param _eas Address of the EAS contract.
    /// @param _requiredSchema The schema UID required for admission.
    /// @param _trustedIssuer The address of the entity allowed to issue admission attestations.
    constructor(
        address _eas,
        bytes32 _requiredSchema,
        address _trustedIssuer
    ) {
        eas = IEAS(_eas);
        requiredSchema = _requiredSchema;
        trustedIssuer = _trustedIssuer;
    }

    /// @inheritdoc IPolicy
    function evaluate(
        address node,
        bytes32,
        /* contextUID */
        bytes calldata entryProof
    ) external view returns (NodeStatus) {
        bytes32 attestationUID = abi.decode(entryProof, (bytes32));

        IEAS.Attestation memory att = eas.getAttestation(attestationUID);

        if (att.uid != attestationUID) revert AttestationNotFound();
        if (att.schema != requiredSchema) revert InvalidSchema();
        if (att.attester != trustedIssuer) revert InvalidIssuer();
        if (att.recipient != node) revert InvalidRecipient();
        if (att.revocationTime != 0) revert AttestationRevoked();

        return NodeStatus.FULL;
    }
}
