// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTClient } from "./IDRIFTClient.sol";

/// @title IDRIFTGovernance
/// @notice Pluggable governance module for DRIFT contexts
interface IDRIFTGovernance is IDRIFTClient {
    // Errors ==================================================================
    error ProposalNotFound(uint256 proposalId);
    error VotingStillActive(uint256 deadline);
    error VotingClosed(uint256 deadline);
    error ProposalDefeated(uint256 votesFor, uint256 votesAgainst);
    error ProposalAlreadyExecuted(uint256 proposalId);
    error AlreadyVoted(address voter, uint256 proposalId);
    error NoVotingPower(address account);
    error ExecutionFailed();
    error UnauthorizedSender(address actual);

    // Events ==================================================================
    event ProposalCreated(uint256 indexed proposalId, string description, uint256 deadline);
    event VoteCast(address indexed voter, uint256 indexed proposalId, bool support, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId);

    // Methods =================================================================
    /// @notice Create a new proposal with an executable payload
    function createProposal(
        string calldata description,
        address target,
        bytes calldata payload,
        uint256 durationInDays
    ) external returns (uint256);

    /// @notice Get proposal details
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

    /// @notice Execute a passed proposal's payload
    function executeProposal(uint256 proposalId) external;

    /// @notice Cast a vote on an active proposal.
    function castVote(uint256 proposalId, bool support) external;

    /// @notice Check if an account has voted on a proposal.
    function hasVoted(uint256 proposalId, address account) external view returns (bool);

    /// @notice Returns the voting power of an address.
    function getVotingPower(address account) external view returns (uint256);
}
