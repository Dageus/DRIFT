// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTClient } from "./IDRIFTClient.sol";

/// @title IDRIFTGovernance
/// @notice Minimal proposal lifecycle interface. Voting mechanisms are implementation-defined.
/// @dev A flat DAO implements this directly. A reputation DAO extends it.
interface IDRIFTGovernance is IDRIFTClient {
    // ERRORS ==================================================================

    error ProposalNotFound(uint256 proposalId);
    error VotingStillActive(uint256 deadline);
    error VotingClosed(uint256 deadline);
    error ProposalDefeated(uint256 votesFor, uint256 votesAgainst);
    error ProposalAlreadyExecuted(uint256 proposalId);
    error AlreadyVoted(address voter, uint256 proposalId);
    error NoVotingPower(address account);
    error ExecutionFailed();
    error UnauthorizedSender(address actual);

    // EVENTS ==================================================================

    /// @notice Emitted when a new proposal is created
    event ProposalCreated(
        uint256 indexed proposalId,
        string description,
        uint256 deadline,
        uint256 snapshotEpoch,
        uint32 configVersion
    );

    /// @notice Emitted when a user casts a vote
    event VoteCast(address indexed voter, uint256 indexed proposalId, bool support, uint256 weight);

    /// @notice Emitted when a passed proposal is successfully executed
    event ProposalExecuted(uint256 indexed proposalId);

    // CORE LIFECYCLE ==========================================================

    /// @notice Creates a new governance proposal
    /// @param description Text description of the proposal
    /// @param target Address to call upon execution
    /// @param payload Calldata to execute on the target
    /// @param durationInDays Length of the voting period
    /// @return The newly created proposal ID
    function createProposal(
        string calldata description,
        address target,
        bytes calldata payload,
        uint256 durationInDays
    ) external returns (uint256);

    /// @notice Executes a passed governance proposal
    /// @param proposalId The ID of the proposal to execute
    function executeProposal(
        uint256 proposalId
    ) external;

    /// @notice Casts a vote on an active proposal
    /// @dev The implementation decides how weight is determined (e.g., flat, token-weighted, or proof-of-state).
    /// @param proposalId The ID of the proposal
    /// @param support True to vote in favor, false to vote against
    function castVote(
        uint256 proposalId,
        bool support
    ) external;

    // VIEWS ===================================================================

    /// @notice Retrieves the current state and details of a proposal
    /// @param proposalId The ID of the proposal
    /// @return description Proposal description
    /// @return target Target execution address
    /// @return payload Calldata to execute
    /// @return votesFor Total power voting in support
    /// @return votesAgainst Total power voting against
    /// @return deadline Timestamp when voting closes
    /// @return executed Whether the proposal has been executed
    /// @return exists Whether the proposal ID is valid
    function getProposal(
        uint256 proposalId
    )
        external
        view
        returns (
            string memory description,
            address target,
            bytes memory payload,
            uint256 votesFor,
            uint256 votesAgainst,
            uint256 deadline,
            bool executed,
            bool exists
        );

    /// @notice Checks if an account has voted on a specific proposal
    /// @param proposalId The ID of the proposal
    /// @param account The address to check
    /// @return True if the account has cast a vote, false otherwise
    function hasVoted(
        uint256 proposalId,
        address account
    ) external view returns (bool);
}
