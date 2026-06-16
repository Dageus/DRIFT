// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTGovernance } from "./IDRIFTGovernance.sol";

/// @title IDRIFTGovernanceProofOfState
/// @notice Extension for epoch-locked, Merkle-proven voting.
/// @dev    Eliminates JIT claim attacks by verifying historical reputation
///         against the epoch root snapshotted at proposal creation.
interface IDRIFTGovernanceProofOfState is IDRIFTGovernance {
    // Errors ==================================================================
    error InvalidProofCount(uint256 roles, uint256 scores, uint256 proofs);
    error RoleHasNoWeight(bytes32 role);
    error NoSettledEpochs();
    error InvalidHistoricalProof();
    error BelowProposalThreshold();
    error MustUseCreateProposalWithProofs();
    error MustUseCastVoteWithProofs();

    // Events ==================================================================
    event ProposalCreated(uint256 indexed proposalId, string description, uint256 deadline, uint256 snapshotEpoch);

    // Replace createProposal with this:
    function createProposalWithProofs(
        string calldata description,
        address target,
        bytes calldata payload,
        uint256 durationInDays,
        bytes32[] calldata roles,
        uint256[] calldata scores,
        bytes32[][] calldata proofs
    ) external returns (uint256);

    // Proof-of-State voting ===================================================
    function castVoteWithProofs(
        uint256 proposalId,
        bool support,
        bytes32[] calldata roles,
        uint256[] calldata scores,
        bytes32[][] calldata proofs
    ) external;

    /// @notice Simulates voting power at a specific epoch by verifying state proofs.
    function getVotingPowerAtEpoch(
        address account,
        uint256 epoch,
        bytes32[] calldata roles,
        uint256[] calldata scores,
        bytes32[][] calldata proofs
    ) external view returns (uint256);
}
