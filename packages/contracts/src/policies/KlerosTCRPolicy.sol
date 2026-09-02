// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IPolicy, NodeStatus } from "./IPolicy.sol";

/// @dev Minimal read surface of Kleros's GeneralizedTCR (kleros/tcr, GeneralizedTCR.sol),
///      verified against source rather than assumed. `Status` enum ordering must match the real
///      contract's exactly, since it's read back as a plain integer. `getItemInfo` is used instead
///      of the `items` public-mapping auto-getter because `Item` contains a dynamic `Request[]`
///      field, which Solidity's auto-generated struct getter silently omits — `getItemInfo` is the
///      real contract's own explicit, stable accessor for exactly this read.
interface IKlerosGTCR {
    enum Status {
        Absent, // Not in the registry.
        Registered, // Currently in the registry.
        RegistrationRequested, // Requested, not yet resolved.
        ClearingRequested // Removal requested, not yet resolved.
    }

    function getItemInfo(
        bytes32 _itemID
    ) external view returns (bytes memory data, Status status, uint256 numberOfRequests);
}

/// @title KlerosTCRPolicy
/// @notice Context admission policy gated by inclusion on a Kleros-curated list (Kleros Curate /
///         GeneralizedTCR) — reads the list's already-resolved state, not a live dispute. Live
///         per-applicant arbitration (submit now, get ruled on later) needs a structurally
///         different, asynchronous mechanism — see DRIFT's B1 challenge/response pattern
///         (WeightedGovernance.sol) for the closest existing template if that's ever built; this
///         policy deliberately targets the far cheaper, already-resolved-list case instead.
/// @dev Fully immutable configuration, matching EASPolicy/VouchingPolicy/BrightIDPolicy's posture.
///      Assumes a one-item-per-address list (itemID = keccak256(abi.encode(address))) — the
///      standard shape for a humanity/allowlist-style Kleros list, but NOT how every TCR encodes
///      its items (e.g. Kleros's own "Tokens" registry encodes multiple fields per item). Confirm
///      the target list actually uses single-address items before pointing this at an existing,
///      not DRIFT-deployed, TCR.
contract KlerosTCRPolicy is IPolicy {
    error NotOnKlerosRegistry(address node);

    /// @notice The Kleros GeneralizedTCR instance this policy reads from.
    IKlerosGTCR public immutable tcr;

    /// @param _tcr Address of the deployed GeneralizedTCR — confirm it encodes items as a single
    ///        address before use.
    constructor(
        address _tcr
    ) {
        tcr = IKlerosGTCR(_tcr);
    }

    /// @inheritdoc IPolicy
    function evaluate(
        address node,
        bytes32,
        /* contextUID */
        bytes calldata /* entryProof */
    ) external view returns (NodeStatus) {
        bytes32 itemID = keccak256(abi.encode(node));
        (, IKlerosGTCR.Status status,) = tcr.getItemInfo(itemID);
        if (status != IKlerosGTCR.Status.Registered) revert NotOnKlerosRegistry(node);
        return NodeStatus.FULL;
    }
}
