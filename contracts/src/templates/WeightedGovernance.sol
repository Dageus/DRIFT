// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import { IDRIFTCore } from "../core/IDRIFTCore.sol";
import { IDRIFTToken } from "../token/IDRIFTToken.sol";
import { IDRIFTSettler } from "../client/IDRIFTSettler.sol";
import { IDRIFTClientMetadata } from "../client/IDRIFTClientMetadata.sol";
import { IDRIFTGovernance } from "../client/IDRIFTGovernance.sol";

contract WeightedGovernanceClient is
    Initializable,
    EIP712Upgradeable,
    IDRIFTGovernance,
    IDRIFTSettler,
    IDRIFTClientMetadata
{
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    error ArrayLengthMismatch();
    error InvalidSettlerSignature();
    error InvalidEpoch(uint256 currEpoch, uint256 expectedEpoch);
    error NodeNotRegistered(bytes32 contextUID, address node);

    IDRIFTCore public core;
    IDRIFTToken public driftToken;
    bytes32 public contextUID;

    address public trustedSettler;

    // Context UID => Node => Role => expected next epoch
    mapping(bytes32 => mapping(address => mapping(bytes32 => uint256))) public expectedEpoch;

    // keccak256(Settle(bytes32 contextUID,address node,bytes32 role,uint256 score,uint256 epoch))
    bytes32 public constant SETTLE_TYPEHASH =
        keccak256("Settle(bytes32 contextUID,address node,bytes32 role,uint256 score,uint256 epoch)");

    bytes32[] public activeRoles;
    mapping(bytes32 => uint256) public roleWeights;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;

    event RoleWeightUpdated(bytes32 role, uint256 weight);

    struct Proposal {
        string description;
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 deadline;
        bool executed;
        bool exists;
        address target;
        bytes payload;
        mapping(address => bool) hasVoted;
    }

    modifier onlyContextAdmin() {
        bytes32 adminRole = core.contextAdminRole(contextUID);
        if (!core.hasRole(adminRole, msg.sender)) {
            revert UnauthorizedSender(msg.sender);
        }
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _core,
        address _token,
        bytes32 _contextUID,
        address _trustedSettler,
        bytes32[] calldata _roles,
        uint256[] calldata _weights
    ) external initializer {
        if (_roles.length != _weights.length) {
            revert ArrayLengthMismatch();
        }

        require(_roles.length <= 10, "Ecosystem role cap exceeded");

        __EIP712_init("DRIFT_WeightedGovernance", "1");

        core = IDRIFTCore(_core);
        driftToken = IDRIFTToken(_token);
        contextUID = _contextUID;
        trustedSettler = _trustedSettler;

        for (uint256 i = 0; i < _roles.length; i++) {
            activeRoles.push(_roles[i]);
            roleWeights[_roles[i]] = _weights[i];
        }
    }

    // Role Weights ============================================================

    function setRoleWeight(bytes32 role, uint256 weight) external {
        if (msg.sender != address(this)) {
            revert UnauthorizedSender(msg.sender);
        }
        roleWeights[role] = weight;
        emit RoleWeightUpdated(role, weight);
    }

    // Reputation settlement ===================================================

    /// @inheritdoc IDRIFTSettler
    function settleReputation(
        address node,
        bytes32 role,
        uint256 score,
        uint256 epoch,
        bytes calldata sig
    ) external override {
        if (!core.isRegistered(contextUID, node)) {
            revert NodeNotRegistered(contextUID, node);
        }

        if (epoch != expectedEpoch[contextUID][node][role]) {
            revert InvalidEpoch(epoch, expectedEpoch[contextUID][node][role]);
        }

        // Increment the epoch BEFORE execution (Checks-Effects-Interactions pattern)
        expectedEpoch[contextUID][node][role]++;

        bytes32 structHash = keccak256(abi.encode(SETTLE_TYPEHASH, contextUID, node, role, score, epoch));
        bytes32 digest = _hashTypedDataV4(structHash);

        if (ECDSA.recover(digest, sig) != trustedSettler) {
            revert InvalidSettlerSignature();
        }

        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, role)));
        uint256 currentReputation = driftToken.balanceOf(node, tokenId);

        if (score > currentReputation) {
            uint256 delta = score - currentReputation;
            core.reward(contextUID, role, node, delta);
        } else if (score < currentReputation) {
            uint256 delta = currentReputation - score;
            core.slash(contextUID, role, node, delta);
        }

        emit ReputationSettled(contextUID, node, role, score, epoch);
    }

    // Governance ==============================================================

    /// @inheritdoc IDRIFTGovernance
    function createProposal(
        string calldata description,
        address target,
        bytes calldata payload,
        uint256 durationInDays
    ) external override onlyContextAdmin returns (uint256) {
        uint256 id = proposalCount++;
        Proposal storage p = proposals[id];
        p.description = description;
        p.deadline = block.timestamp + (durationInDays * 1 days);
        p.exists = true;
        p.target = target;
        p.payload = payload;

        emit ProposalCreated(id, description, p.deadline);
        return id;
    }

    /// @inheritdoc IDRIFTGovernance
    function executeProposal(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];

        if (!p.exists) revert ProposalNotFound(proposalId);
        if (block.timestamp < p.deadline) revert VotingStillActive(p.deadline);
        if (p.votesFor <= p.votesAgainst) revert ProposalDefeated(p.votesFor, p.votesAgainst);
        if (p.executed) revert ProposalAlreadyExecuted(proposalId);

        p.executed = true;

        (bool success, ) = p.target.call(p.payload);
        if (!success) revert ExecutionFailed();
    }

    /// @inheritdoc IDRIFTGovernance
    function castVote(uint256 proposalId, bool support) external override {
        Proposal storage p = proposals[proposalId];

        if (!p.exists) revert ProposalNotFound(proposalId);
        if (block.timestamp >= p.deadline) revert VotingClosed(p.deadline);
        if (p.hasVoted[msg.sender]) revert AlreadyVoted(msg.sender, proposalId);

        uint256 power = getVotingPower(msg.sender);
        if (power == 0) revert NoVotingPower(msg.sender);

        p.hasVoted[msg.sender] = true;

        if (support) {
            p.votesFor += power;
        } else {
            p.votesAgainst += power;
        }

        emit VoteCast(msg.sender, proposalId, support, power);
    }

    /// @inheritdoc IDRIFTGovernance
    function getVotingPower(address account) public view override returns (uint256 totalPower) {
        for (uint256 i = 0; i < activeRoles.length; i++) {
            bytes32 role = activeRoles[i];
            uint256 weight = roleWeights[role];
            uint256 tokenId = uint256(keccak256(abi.encode(contextUID, role)));
            uint256 balance = driftToken.balanceOf(account, tokenId);
            totalPower += (balance * weight);
        }
    }

    /// @inheritdoc IDRIFTGovernance
    function hasVoted(uint256 proposalId, address account) external view override returns (bool) {
        return proposals[proposalId].hasVoted[account];
    }

    /// @inheritdoc IDRIFTGovernance
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
        // Added p.executed to the return tuple
        return (p.description, p.target, p.payload, p.votesFor, p.votesAgainst, p.deadline, p.executed, p.exists);
    }

    // Metadata ================================================================

    /// @inheritdoc IDRIFTClientMetadata
    function version() external pure override returns (string memory) {
        return "1.0.0";
    }

    /// @inheritdoc IDRIFTClientMetadata
    function metadata() external pure override returns (string memory name, string memory description) {
        return ("Weighted Governance", "Multiplies ERC-1155 balances by configurable role weights.");
    }
}
