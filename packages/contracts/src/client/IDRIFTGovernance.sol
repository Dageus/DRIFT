// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTClient } from "./IDRIFTClient.sol";

/// @title IDRIFTGovernance
/// @notice Minimal proposal lifecycle. Voting mechanism is implementation-defined.
/// @dev    A flat DAO implements this directly. A reputation DAO extends it.
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

    // Core lifecycle ==========================================================
    function createProposal(
        string calldata description,
        address target,
        bytes calldata payload,
        uint256 durationInDays
    ) external returns (uint256);

    function executeProposal(uint256 proposalId) external;

    /// @notice Cast a vote. The implementation decides how weight is determined.
    /// @dev    For a flat DAO, this might be 1 vote per registered node.
    ///         For a token-weighted DAO, this reads live balances.
    ///         For Proof-of-State, the client exposes a separate function.
    function castVote(uint256 proposalId, bool support) external;

    // Views ===================================================================
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

    function hasVoted(uint256 proposalId, address account) external view returns (bool);
}
