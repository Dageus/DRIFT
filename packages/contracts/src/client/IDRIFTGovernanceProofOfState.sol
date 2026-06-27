// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTGovernance } from "./IDRIFTGovernance.sol";

/// @title IDRIFTGovernanceProofOfState
/// @notice Extension for epoch-locked, Merkle-proven voting.
/// @dev Eliminates JIT claim attacks by verifying historical reputation against the epoch root snapshotted at proposal creation.
interface IDRIFTGovernanceProofOfState is IDRIFTGovernance {
    // ERRORS ==================================================================

    error InvalidProofCount(uint256 roles, uint256 scores, uint256 proofs);
    error RoleHasNoWeight(bytes32 role);
    error NoSettledEpochs();
    error InvalidHistoricalProof();
    error BelowProposalThreshold();
    error MustUseCreateProposalWithProofs();
    error MustUseCastVoteWithProofs();

    // EVENTS ==================================================================

    /// @notice Emitted when a proposal requiring state proofs is created
    event ProposalCreated(
        uint256 indexed proposalId, string description, uint256 deadline, uint256 snapshotEpoch
    );

    // PROOF-OF-STATE LIFECYCLE ================================================

    /// @notice Creates a proposal using Merkle state proofs for voter power validation
    /// @dev Replaces standard createProposal in Proof-of-State environments
    /// @param description Text description of the proposal
    /// @param target Address to call upon execution
    /// @param payload Calldata to execute on the target
    /// @param durationInDays Length of the voting period
    /// @param roles Array of roles the caller is claiming power for
    /// @param scores Array of scores corresponding to those roles
    /// @param proofs Array of merkle proofs for those claims
    /// @return The newly created proposal ID
    function createProposalWithProofs(
        string calldata description,
        address target,
        bytes calldata payload,
        uint256 durationInDays,
        bytes32[] calldata roles,
        uint256[] calldata scores,
        bytes32[][] calldata proofs
    ) external returns (uint256);

    /// @notice Casts a vote on an active proposal using Merkle state proofs
    /// @dev Replaces standard castVote in Proof-of-State environments
    /// @param proposalId The ID of the proposal
    /// @param support True to vote in favor, false to vote against
    /// @param roles Array of roles the caller is claiming power for
    /// @param scores Array of scores corresponding to those roles
    /// @param proofs Array of merkle proofs for those claims
    function castVoteWithProofs(
        uint256 proposalId,
        bool support,
        bytes32[] calldata roles,
        uint256[] calldata scores,
        bytes32[][] calldata proofs
    ) external;

    // VIEWS ===================================================================

    /// @notice Simulates voting power at a specific epoch by verifying state proofs
    /// @param account The address to check
    /// @param epoch The epoch ID to simulate against
    /// @param roles Array of claimed roles
    /// @param scores Array of claimed scores
    /// @param proofs Array of Merkle proofs for the claims
    /// @return The total verified voting power for the account at that epoch
    function getVotingPowerAtEpoch(
        address account,
        uint256 epoch,
        bytes32[] calldata roles,
        uint256[] calldata scores,
        bytes32[][] calldata proofs
    ) external view returns (uint256);
}
