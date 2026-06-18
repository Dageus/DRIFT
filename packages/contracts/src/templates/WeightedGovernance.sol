// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import { IDRIFTCore } from "../core/IDRIFTCore.sol";
import { IDRIFTToken } from "../token/IDRIFTToken.sol";
import { IDRIFTSettler } from "../client/IDRIFTSettler.sol";
import { IDRIFTClientMetadata } from "../client/IDRIFTClientMetadata.sol";
import { IDRIFTGovernanceProofOfState } from "../client/IDRIFTGovernanceProofOfState.sol";

/// @title Weighted Governance Client
/// @notice Implements proof-of-state governance using configurable role-based weights.
/// @dev Integrates closely with DRIFT core components to manage epoch-based reputation claims.
contract WeightedGovernanceClient is
    Initializable,
    EIP712Upgradeable,
    IDRIFTGovernanceProofOfState,
    IDRIFTSettler,
    IDRIFTClientMetadata
{
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // Custom Errors
    error ArrayLengthMismatch();
    error InvalidEpoch(uint256 currEpoch, uint256 expectedEpoch);
    error NodeNotRegistered(bytes32 contextUID, address node);
    error MaximumRoleLengthExceeded();
    error ZeroAddressSettler();

    // State Variables
    string private _reputationAlgorithm;
    IDRIFTCore public core;
    IDRIFTToken public driftToken;
    bytes32 public contextUID;
    uint256 public proposalThreshold;
    address public trustedSettler;
    uint256 public currentEpoch;

    bytes32 public constant SETTLE_ROOT_TYPEHASH =
        keccak256("SettleRoot(bytes32 contextUID,uint256 epoch,bytes32 merkleRoot)");

    // Mappings
    mapping(uint256 => bytes32) public epochRoots;
    mapping(address => mapping(bytes32 => uint256)) public lastClaimedEpoch;

    bytes32[] public activeRoles;
    mapping(bytes32 => uint256) public roleWeights;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;

    // Events
    event RoleWeightUpdated(bytes32 indexed role, uint256 weight);

    /// @notice Struct representing a governance proposal
    /// @dev Packed tightly to optimize storage. target (20) + executed (1) + exists (1) = 22 bytes (1 slot).
    struct Proposal {
        string description;
        bytes payload;
        address target;
        bool executed;
        bool exists;
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 deadline;
        uint256 snapshotEpoch;
        mapping(address => bool) hasVoted;
    }

    // MODIFIERS & INIT ========================================================

    /// @notice Ensures caller holds the context admin role
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

    /// @notice Initializes the weighted governance contract
    /// @param _core Address of the DRIFT core contract
    /// @param _token Address of the DRIFT token contract
    /// @param _contextUID Unique identifier for the context
    /// @param _trustedSettler Address authorized to settle epochs
    /// @param _proposalThreshold Minimum voting power required to propose
    /// @param initialAlgorithm String identifier of the reputation algorithm
    /// @param _roles Array of active roles for this governance client
    /// @param _weights Array of weights corresponding to the roles
    function initialize(
        address _core,
        address _token,
        bytes32 _contextUID,
        address _trustedSettler,
        uint256 _proposalThreshold,
        string calldata initialAlgorithm,
        bytes32[] calldata _roles,
        uint256[] calldata _weights
    ) external initializer {
        if (_roles.length != _weights.length) revert ArrayLengthMismatch();
        if (_roles.length > 10) revert MaximumRoleLengthExceeded();

        __EIP712_init("DRIFT_WeightedGovernance", "1");

        core = IDRIFTCore(_core);
        driftToken = IDRIFTToken(_token);
        contextUID = _contextUID;
        trustedSettler = _trustedSettler;
        proposalThreshold = _proposalThreshold;
        _reputationAlgorithm = initialAlgorithm;

        for (uint256 i = 0; i < _roles.length; i++) {
            activeRoles.push(_roles[i]);
            roleWeights[_roles[i]] = _weights[i];
        }
    }

    // ROLE WEIGHTS & CONFIG ===================================================

    /// @notice Updates the voting weight associated with a specific role
    /// @param role The identifier of the role
    /// @param weight The new weight to apply
    function setRoleWeight(bytes32 role, uint256 weight) external {
        if (msg.sender != address(this) && !core.hasRole(core.contextAdminRole(contextUID), msg.sender)) {
            revert UnauthorizedSender(msg.sender);
        }
        roleWeights[role] = weight;
        emit RoleWeightUpdated(role, weight);
    }

    /// @notice Updates the trusted settler address
    /// @param newSettler The new address authorized to sign epoch roots
    function setTrustedSettler(address newSettler) external onlyContextAdmin {
        if (newSettler == address(0)) revert ZeroAddressSettler();
        address oldSettler = trustedSettler;
        trustedSettler = newSettler;
        emit SettlerUpdated(oldSettler, trustedSettler);
    }

    /// @notice Updates the string identifier of the reputation algorithm
    /// @param newAlgorithm The name or URI of the new algorithm
    function setReputationAlgorithm(string calldata newAlgorithm) external onlyContextAdmin {
        _reputationAlgorithm = newAlgorithm;
    }

    // REPUTATION SETTLEMENT ===================================================

    /// @notice Posts a new epoch root to the contract
    /// @param epoch The sequential epoch ID being settled
    /// @param merkleRoot The merkle root containing node state data
    /// @param sig EIP-712 signature from the trusted settler
    function postEpochRoot(uint256 epoch, bytes32 merkleRoot, bytes calldata sig) external {
        if (epoch != currentEpoch + 1) revert InvalidEpoch(epoch, currentEpoch + 1);
        if (epochRoots[epoch] != bytes32(0)) revert EpochAlreadyPosted(epoch);

        bytes32 structHash = keccak256(abi.encode(SETTLE_ROOT_TYPEHASH, contextUID, epoch, merkleRoot));
        bytes32 digest = _hashTypedDataV4(structHash);
        if (ECDSA.recover(digest, sig) != trustedSettler) revert InvalidSettlerSignature();

        currentEpoch = epoch;
        epochRoots[epoch] = merkleRoot;

        emit EpochRootPosted(contextUID, epoch, merkleRoot);
    }

    /// @notice Claims reputation tokens for a node in a specific epoch
    /// @param node Address of the node
    /// @param role Role being claimed for
    /// @param score The target reputation score
    /// @param epoch The epoch being claimed
    /// @param merkleProof Merkle proof validating the node's state
    function claimReputation(
        address node,
        bytes32 role,
        uint256 score,
        uint256 epoch,
        bytes32[] calldata merkleProof
    ) external {
        if (!core.isRegistered(contextUID, node)) revert NodeNotRegistered(contextUID, node);
        if (epochRoots[epoch] == bytes32(0)) revert EpochNotFound(epoch);
        if (epoch <= lastClaimedEpoch[node][role]) revert AlreadyClaimed(node, role, epoch);

        bytes32 leaf = _canonicalLeaf(node, role, score, epoch);
        if (!MerkleProof.verify(merkleProof, epochRoots[epoch], leaf)) revert InvalidMerkleProof();

        lastClaimedEpoch[node][role] = epoch;

        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, role)));
        uint256 currentReputation = driftToken.balanceOf(node, tokenId);

        if (score > currentReputation) {
            uint256 delta = score - currentReputation;
            core.reward(contextUID, role, node, delta);
        } else if (score < currentReputation) {
            uint256 delta = currentReputation - score;
            core.slash(contextUID, role, node, delta);
        }

        emit ReputationClaimed(contextUID, node, role, score, epoch);
    }

    /// @inheritdoc IDRIFTSettler
    function verifyReputation(
        address node,
        bytes32 role,
        uint256 score,
        uint256 epoch,
        bytes32[] calldata merkleProof
    ) external view override returns (bool) {
        if (epochRoots[epoch] == bytes32(0)) return false;

        bytes32 leaf = _canonicalLeaf(node, role, score, epoch);
        return MerkleProof.verify(merkleProof, epochRoots[epoch], leaf);
    }

    // GOVERNANCE: PROPOSALS ===================================================

    /// @dev Disabled. All voting in this client requires Merkle state proofs.
    function createProposal(
        string calldata,
        address,
        bytes calldata,
        uint256
    ) external pure override returns (uint256) {
        revert MustUseCreateProposalWithProofs();
    }

    /// @notice Creates a new proposal using state proofs for voter power validation
    /// @param description Text description of the proposal
    /// @param target Address to call if proposal passes
    /// @param payload Calldata to execute on the target address
    /// @param durationInDays How many days the voting period lasts
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
    ) external returns (uint256) {
        if (currentEpoch == 0) revert NoSettledEpochs();
        if (roles.length != scores.length || roles.length != proofs.length) revert ArrayLengthMismatch();

        uint256 proposerPower = 0;
        bytes32 root = epochRoots[currentEpoch];

        for (uint256 i = 0; i < roles.length; i++) {
            bytes32 role = roles[i];
            uint256 score = scores[i];

            bytes32 leaf = _canonicalLeaf(msg.sender, role, score, currentEpoch);
            if (!MerkleProof.verify(proofs[i], root, leaf)) revert InvalidMerkleProof();

            proposerPower += (score * roleWeights[role]);
        }

        if (proposerPower < proposalThreshold) revert BelowProposalThreshold();

        uint256 id = proposalCount++;
        Proposal storage p = proposals[id];

        p.description = description;
        p.deadline = block.timestamp + (durationInDays * 1 days);
        p.exists = true;
        p.target = target;
        p.payload = payload;
        p.snapshotEpoch = currentEpoch; // Lock the voting checkpoint

        emit ProposalCreated(id, description, p.deadline, p.snapshotEpoch);
        return id;
    }

    /// @notice Executes a passed proposal
    /// @param proposalId The ID of the proposal to execute
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

    // GOVERNANCE: VOTING ======================================================

    /// @dev Disabled. All voting in this client requires Merkle state proofs.
    function castVote(uint256, bool) external pure override {
        revert MustUseCastVoteWithProofs();
    }

    /// @notice Casts a vote on a proposal using state proofs for voting power
    /// @param proposalId The ID of the proposal
    /// @param support True for yes, false for no
    /// @param roles Array of roles the caller is claiming power for
    /// @param scores Array of scores corresponding to those roles
    /// @param proofs Array of merkle proofs for those claims
    function castVoteWithProofs(
        uint256 proposalId,
        bool support,
        bytes32[] calldata roles,
        uint256[] calldata scores,
        bytes32[][] calldata proofs
    ) external override {
        Proposal storage p = proposals[proposalId];

        if (!p.exists) revert ProposalNotFound(proposalId);
        if (block.timestamp >= p.deadline) revert VotingClosed(p.deadline);
        if (p.hasVoted[msg.sender]) revert AlreadyVoted(msg.sender, proposalId);
        if (roles.length != scores.length || roles.length != proofs.length) {
            revert InvalidProofCount(roles.length, scores.length, proofs.length);
        }

        bytes32 root = epochRoots[p.snapshotEpoch];
        if (root == bytes32(0)) revert EpochNotFound(p.snapshotEpoch);

        uint256 totalPower = 0;

        for (uint256 i = 0; i < roles.length; i++) {
            bytes32 role = roles[i];
            uint256 weight = roleWeights[role];
            if (weight == 0) revert RoleHasNoWeight(role);

            bytes32 leaf = _canonicalLeaf(msg.sender, role, scores[i], p.snapshotEpoch);
            if (!MerkleProof.verify(proofs[i], root, leaf)) revert InvalidMerkleProof();

            totalPower += scores[i] * weight;
        }

        if (totalPower == 0) revert NoVotingPower(msg.sender);

        p.hasVoted[msg.sender] = true;
        if (support) {
            p.votesFor += totalPower;
        } else {
            p.votesAgainst += totalPower;
        }

        emit VoteCast(msg.sender, proposalId, support, totalPower);
    }

    // GOVERNANCE: VIEWS =======================================================

    /// @inheritdoc IDRIFTGovernanceProofOfState
    function getVotingPowerAtEpoch(
        address account,
        uint256 epoch,
        bytes32[] calldata roles,
        uint256[] calldata scores,
        bytes32[][] calldata proofs
    ) public view override returns (uint256 totalPower) {
        if (!core.isRegistered(contextUID, account)) return 0;
        if (roles.length != scores.length || roles.length != proofs.length) revert ArrayLengthMismatch();

        bytes32 root = epochRoots[epoch];
        if (root == bytes32(0)) revert EpochNotFound(epoch);

        for (uint256 i = 0; i < roles.length; i++) {
            bytes32 leaf = _canonicalLeaf(account, roles[i], scores[i], epoch);
            if (!MerkleProof.verify(proofs[i], root, leaf)) revert InvalidMerkleProof();
            totalPower += (scores[i] * roleWeights[roles[i]]);
        }
    }

    /// @notice Returns the list of active roles for this governance context
    /// @return Array of role identifiers
    function getActiveRoles() external view returns (bytes32[] memory) {
        return activeRoles;
    }

    /// @notice Checks if an account has voted on a given proposal
    /// @param proposalId The ID of the proposal
    /// @param account Address of the user
    /// @return True if the user has voted, false otherwise
    function hasVoted(uint256 proposalId, address account) external view override returns (bool) {
        return proposals[proposalId].hasVoted[account];
    }

    /// @notice Retrieves the current state of a proposal
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

    // METADATA ================================================================

    /// @inheritdoc IDRIFTClientMetadata
    function version() external pure override returns (string memory) {
        return "1.1.0";
    }

    /// @inheritdoc IDRIFTClientMetadata
    function reputationAlgorithm() external view returns (string memory) {
        return _reputationAlgorithm;
    }

    /// @inheritdoc IDRIFTClientMetadata
    function metadata() external pure override returns (string memory name, string memory description) {
        return ("Weighted Governance", "Multiplies ERC-1155 balances by configurable role weights.");
    }

    // INTERNAL ================================================================

    /// @notice Generates a standardized leaf hash for verifying Merkle proofs
    /// @param node Address of the node
    /// @param role Role being claimed or verified
    /// @param score The score or power associated with the claim
    /// @param epoch The epoch ID
    /// @return bytes32 double-hashed canonical leaf
    function _canonicalLeaf(address node, bytes32 role, uint256 score, uint256 epoch) internal view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(contextUID, node, role, score, epoch))));
    }
}
