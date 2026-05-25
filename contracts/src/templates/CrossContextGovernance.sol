// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { IDRIFTCore } from "../core/IDRIFTCore.sol";
import { IDRIFTToken } from "../token/IDRIFTToken.sol";
import { IDRIFTGovernance } from "../client/IDRIFTGovernance.sol";

/// @notice Aggregates voting power across MULTIPLE contexts.
contract CrossContextGovernance is Initializable, IDRIFTGovernance {
    error ArrayLengthMismatch();

    IDRIFTCore public core;
    IDRIFTToken public driftToken;
    bytes32 public contextUID;
    address public admin;

    struct Target {
        bytes32 context;
        bytes32 role;
        uint256 weight;
    }

    Target[] public targets;
    uint256 public totalWeightBps;

    // Governance state ========================================================
    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;

    struct Proposal {
        string description;
        address target;
        bytes payload;
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 deadline;
        bool executed;
        bool exists;
        mapping(address => bool) hasVoted;
    }

    modifier onlyContextAdmin() {
        bytes32 adminRole = core.contextAdminRole(contextUID);
        if (!core.hasRole(adminRole, msg.sender)) {
            revert UnauthorizedSender(msg.sender);
        }
        _;
    }

    function initialize(
        address _core,
        address _token,
        bytes32 _contextUID,
        bytes32[] calldata _contexts,
        bytes32[] calldata _roles,
        uint256[] calldata _weights
    ) external initializer {
        if (_contexts.length != _weights.length) {
            revert ArrayLengthMismatch();
        }

        if (_contexts.length != _roles.length) {
            revert ArrayLengthMismatch();
        }

        core = IDRIFTCore(_core);
        driftToken = IDRIFTToken(_token);
        contextUID = _contextUID;
        admin = msg.sender;

        for (uint256 i = 0; i < _contexts.length; i++) {
            targets.push(Target({ context: _contexts[i], role: _roles[i], weight: _weights[i] }));
            totalWeightBps += _weights[i];
        }
    }

    // Voting power aggregation ================================================

    function getVotingPower(address account) public view override returns (uint256 totalPower) {
        for (uint256 i = 0; i < targets.length; i++) {
            Target memory t = targets[i];
            uint256 tokenId = uint256(keccak256(abi.encode(t.context, t.role)));
            uint256 balance = driftToken.balanceOf(account, tokenId);
            totalPower += (balance * t.weight) / totalWeightBps;
        }
    }

    // Governance ==============================================================

    function createProposal(
        string calldata description,
        address target,
        bytes calldata payload,
        uint256 durationInDays
    ) external override onlyContextAdmin returns (uint256) {
        uint256 id = proposalCount++;
        Proposal storage p = proposals[id];

        p.description = description;
        p.target = target;
        p.payload = payload;
        p.deadline = block.timestamp + (durationInDays * 1 days);
        p.exists = true;

        emit ProposalCreated(id, description, p.deadline);
        return id;
    }

    function castVote(uint256 proposalId, bool support) external override {
        Proposal storage p = proposals[proposalId];
        if (!p.exists) revert ProposalNotFound(proposalId);
        if (block.timestamp >= p.deadline) revert VotingClosed(p.deadline);
        if (p.hasVoted[msg.sender]) revert AlreadyVoted(msg.sender, proposalId);

        uint256 power = getVotingPower(msg.sender);
        if (power == 0) revert NoVotingPower(msg.sender);

        p.hasVoted[msg.sender] = true;
        if (support) p.votesFor += power;
        else p.votesAgainst += power;

        emit VoteCast(msg.sender, proposalId, support, power);
    }

    function executeProposal(uint256 proposalId) external override {
        Proposal storage p = proposals[proposalId];
        if (!p.exists) revert ProposalNotFound(proposalId);
        if (block.timestamp < p.deadline) revert VotingStillActive(p.deadline);
        if (p.votesFor <= p.votesAgainst) revert ProposalDefeated(p.votesFor, p.votesAgainst);
        if (p.executed) revert ProposalAlreadyExecuted(proposalId);

        p.executed = true;

        (bool success, ) = p.target.call(p.payload);
        if (!success) revert ExecutionFailed();

        emit ProposalExecuted(proposalId);
    }

    function hasVoted(uint256 proposalId, address account) external view override returns (bool) {
        return proposals[proposalId].hasVoted[account];
    }

    function getProposal(
        uint256 proposalId
    )
        external
        view
        override
        returns (
            string memory description,
            address target,
            bytes memory payload,
            uint256 votesFor,
            uint256 votesAgainst,
            uint256 deadline,
            bool executed,
            bool exists
        )
    {
        Proposal storage p = proposals[proposalId];
        return (p.description, p.target, p.payload, p.votesFor, p.votesAgainst, p.deadline, p.executed, p.exists);
    }
}
