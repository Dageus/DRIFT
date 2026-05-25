// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IPolicy, NodeStatus } from "./IPolicy.sol";
import { IEAS } from "../interfaces/IEAS.sol";

contract EASPolicy is IPolicy {
    IEAS public immutable eas;
    bytes32 public immutable requiredSchema;
    address public immutable trustedIssuer;

    constructor(address _eas, bytes32 _requiredSchema, address _trustedIssuer) {
        eas = IEAS(_eas);
        requiredSchema = _requiredSchema;
        trustedIssuer = _trustedIssuer;
    }

    /// @inheritdoc IPolicy
    function evaluate(
        address node,
        bytes32 /* contextUID */,
        bytes calldata entryProof
    ) external view returns (NodeStatus) {
        bytes32 attestationUID = abi.decode(entryProof, (bytes32));

        IEAS.Attestation memory att = eas.getAttestation(attestationUID);

        require(att.uid == attestationUID, "EASPolicy: Attestation not found");
        require(att.schema == requiredSchema, "EASPolicy: Invalid schema");
        require(att.attester == trustedIssuer, "EASPolicy: Invalid issuer");
        require(att.recipient == node, "EASPolicy: Attestation not issued to this node");
        require(att.revocationTime == 0, "EASPolicy: Attestation was revoked");

        return NodeStatus.FULL;
    }
}
