// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { DRIFTTypes } from "../Common.sol";
import { IDRIFTClientMetadata } from "../client/IDRIFTClientMetadata.sol";
import { IDRIFTGovernanceProofOfState } from "../client/IDRIFTGovernanceProofOfState.sol";
import { IDRIFTSettler } from "../client/IDRIFTSettler.sol";
import { IDRIFTCore } from "../core/IDRIFTCore.sol";
import { IDRIFTToken } from "../token/IDRIFTToken.sol";

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
    error QuorumNotReached(uint256 total, uint256 required);
    error WeightConfigVersionNotFound(uint32 version);
    error EpochLengthAlreadySet();
    error InvalidEpochLength();
    error EpochLengthNotConfigured();
    error EpochNotYetElapsed(uint256 requiredBlock, uint256 currentBlock);
    error WeightsNotNormalized(uint256 sum, uint256 expected);

    // State Variables
    string private _reputationAlgorithm;
    IDRIFTCore public core;
    IDRIFTToken public driftToken;
    bytes32 public contextUID;
    uint256 public proposalThreshold;
    address public trustedSettler;
    uint256 public currentEpoch;
    uint256 public quorumThreshold;

    /// @notice Epoch length in blocks (β). Fixed once via `setEpochLength`; 0 means unconfigured.
    uint256 public epochLength;
    /// @notice Block height epoch boundaries are anchored to (h_0). Set alongside epochLength.
    uint256 public epochAnchorBlock;

    bytes32 public constant SETTLE_ROOT_TYPEHASH = keccak256(
        "SettleRoot(bytes32 contextUID,uint256 epoch,bytes32 merkleRoot,string treeURI)"
    );

    /// @notice Fixed-point scale role weights must sum to (w_r in [0, WEIGHT_SCALE], sum == WEIGHT_SCALE).
    uint256 public constant WEIGHT_SCALE = 10_000;

    // B1 — non-inclusion disputes =============================================

    /// @notice Floor a non-zero settlementBond/challengeBond must clear. Plain constants rather
    ///         than admin-configurable values, so an admin (or an admin colluding with the
    ///         settler) can never grief the bond down to economically meaningless.
    uint256 public constant MIN_SETTLEMENT_BOND = 0.001 ether;
    uint256 public constant MIN_CHALLENGE_BOND = 0.001 ether;

    /// @notice Wei the settler must escrow per posted epoch, forfeited on a successful challenge.
    uint256 public settlementBond;
    /// @notice Wei a challenger must escrow to open a non-inclusion challenge.
    uint256 public challengeBond;
    /// @notice Blocks after posting during which a non-inclusion challenge may be opened.
    ///         One-time set via `setDisputeWindow`; 0 means unconfigured.
    uint256 public disputeWindow;
    /// @notice Blocks an open challenge has for a rebuttal before it can be claimed unanswered.
    ///         One-time set via `setResponseWindow`; 0 means unconfigured.
    uint256 public responseWindow;

    /// @notice Block at which each epoch's root was posted.
    mapping(uint256 => uint256) public epochPostedAtBlock;
    /// @notice The settler's escrowed bond for each epoch (zeroed once withdrawn or forfeited).
    mapping(uint256 => uint256) public epochBondAmount;
    /// @notice Count of unresolved challenges currently open against each epoch.
    mapping(uint256 => uint256) public openChallengeCount;
    /// @notice Number of consecutive epoch rollbacks (unanswered challenges), reset to 0 the next
    ///         time an epoch finalizes cleanly. Read-only signal for admins deciding whether to
    ///         rotate the settler via the existing `setTrustedSettler` — no auto-rotation.
    uint256 public consecutiveFailedEpochs;

    struct Challenge {
        uint256 openedAtBlock;
        uint256 bond;
        address challenger;
        bool resolved;
    }

    /// @notice epoch => missing node => open/resolved challenge. Concurrent per-node, not
    ///         serialized per-epoch — see `challengeOmission`.
    mapping(uint256 => mapping(address => Challenge)) public challenges;

    // Mappings
    mapping(uint256 => bytes32) public epochRoots;
    mapping(address => mapping(bytes32 => uint256)) public lastClaimedEpoch;

    bytes32[] public activeRoles;
    mapping(bytes32 => uint256) public roleWeights;

    // Versioned Weight Configuration
    uint32 public currentConfigVersion;
    mapping(uint32 => WeightConfig) private _weightHistory;
    /// @notice The weight config version in effect when each epoch was settled (set in postEpochRoot).
    mapping(uint256 => uint32) public epochConfigVersion;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;

    // Events
    event RoleWeightsUpdated(uint32 indexed configVersion);
    event EpochLengthConfigured(uint256 epochLength, uint256 epochAnchorBlock);

    /// @notice Struct representing a versioned weight configuration snapshot
    struct WeightConfig {
        bytes32[] roles;
        mapping(bytes32 => uint256) weights;
    }

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
        uint32 configVersion;
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
    /// @param _quorum Minimum number of votes for a proposal to pass
    /// @param initialAlgorithm String identifier of the reputation algorithm
    /// @param _roles Array of active roles for this governance client
    /// @param _weights Array of weights corresponding to the roles
    function initialize(
        address _core,
        address _token,
        bytes32 _contextUID,
        address _trustedSettler,
        uint256 _proposalThreshold,
        uint256 _quorum,
        string calldata initialAlgorithm,
        bytes32[] calldata _roles,
        uint256[] calldata _weights
    ) external initializer {
        if (_roles.length != _weights.length) revert ArrayLengthMismatch();
        if (_roles.length > 10) revert MaximumRoleLengthExceeded();

        uint256 weightSum = 0;
        for (uint256 i = 0; i < _weights.length; i++) {
            weightSum += _weights[i];
        }
        if (weightSum != WEIGHT_SCALE) revert WeightsNotNormalized(weightSum, WEIGHT_SCALE);

        __EIP712_init("DRIFT_WeightedGovernance", "1");

        core = IDRIFTCore(_core);
        driftToken = IDRIFTToken(_token);
        contextUID = _contextUID;
        trustedSettler = _trustedSettler;
        proposalThreshold = _proposalThreshold;
        _reputationAlgorithm = initialAlgorithm;
        quorumThreshold = _quorum;

        for (uint256 i = 0; i < _roles.length; i++) {
            activeRoles.push(_roles[i]);
            roleWeights[_roles[i]] = _weights[i];
        }

        // Initialize config version 0 with the initial weights
        currentConfigVersion = 0;
        WeightConfig storage initialConfig = _weightHistory[0];
        for (uint256 i = 0; i < _roles.length; i++) {
            initialConfig.roles.push(_roles[i]);
            initialConfig.weights[_roles[i]] = _weights[i];
        }
    }

    // ROLE WEIGHTS & CONFIG ===================================================

    /// @notice Replaces the full active role set and weights in one call. Weights must sum to
    ///         WEIGHT_SCALE — a single-role update cannot preserve that invariant, so partial
    ///         weight edits are not supported.
    /// @param roles Complete set of active roles after this call
    /// @param weights Weights corresponding to `roles`, must sum to WEIGHT_SCALE
    function setRoleWeights(
        bytes32[] calldata roles,
        uint256[] calldata weights
    ) external onlyContextAdmin {
        if (roles.length != weights.length) revert ArrayLengthMismatch();
        if (roles.length > 10) revert MaximumRoleLengthExceeded();

        uint256 weightSum = 0;
        for (uint256 i = 0; i < weights.length; i++) {
            weightSum += weights[i];
        }
        if (weightSum != WEIGHT_SCALE) revert WeightsNotNormalized(weightSum, WEIGHT_SCALE);

        uint256 activeRolesLength = activeRoles.length;
        for (uint256 i = 0; i < activeRolesLength; i++) {
            delete roleWeights[activeRoles[i]];
        }
        delete activeRoles;

        currentConfigVersion++;
        WeightConfig storage newConfig = _weightHistory[currentConfigVersion];

        for (uint256 i = 0; i < roles.length; i++) {
            activeRoles.push(roles[i]);
            roleWeights[roles[i]] = weights[i];
            newConfig.roles.push(roles[i]);
            newConfig.weights[roles[i]] = weights[i];
        }

        emit RoleWeightsUpdated(currentConfigVersion);
    }

    /// @notice Fixes the epoch length (β, in blocks) and anchors epoch boundaries to the current
    ///         block (h_0). Callable exactly once — boundaries are immutable thereafter, so the
    ///         settler cannot choose epoch windows after the fact.
    /// @param blocks_ Number of blocks per epoch. Must be non-zero.
    function setEpochLength(
        uint256 blocks_
    ) external onlyContextAdmin {
        if (epochLength != 0) revert EpochLengthAlreadySet();
        if (blocks_ == 0) revert InvalidEpochLength();

        epochLength = blocks_;
        epochAnchorBlock = block.number;

        emit EpochLengthConfigured(blocks_, block.number);
    }

    /// @notice Fixes the non-inclusion challenge window (in blocks). Callable exactly once, same
    ///         pattern as `setEpochLength`. Required before `postEpochRoot` will accept a root.
    function setDisputeWindow(
        uint256 blocks_
    ) external onlyContextAdmin {
        if (disputeWindow != 0) revert DisputeWindowAlreadySet();
        if (blocks_ == 0) revert InvalidDisputeWindow();
        disputeWindow = blocks_;
    }

    /// @notice Fixes the challenge response window (in blocks). Callable exactly once. Required
    ///         before `postEpochRoot` will accept a root.
    function setResponseWindow(
        uint256 blocks_
    ) external onlyContextAdmin {
        if (responseWindow != 0) revert ResponseWindowAlreadySet();
        if (blocks_ == 0) revert InvalidResponseWindow();
        responseWindow = blocks_;
    }

    /// @notice Sets the settler's per-epoch settlement bond. Enforced >= MIN_SETTLEMENT_BOND
    ///         whenever it's actually required (at `postEpochRoot` time), not just here — so
    ///         simply never calling this can't leave a silent zero-bond hole.
    function setSettlementBond(
        uint256 amount
    ) external onlyContextAdmin {
        if (amount < MIN_SETTLEMENT_BOND) revert BondBelowFloor(amount, MIN_SETTLEMENT_BOND);
        settlementBond = amount;
    }

    /// @notice Sets the challenger's bond for opening a non-inclusion challenge.
    function setChallengeBond(
        uint256 amount
    ) external onlyContextAdmin {
        if (amount < MIN_CHALLENGE_BOND) revert BondBelowFloor(amount, MIN_CHALLENGE_BOND);
        challengeBond = amount;
    }

    /// @notice Updates the trusted settler address
    /// @param newSettler The new address authorized to sign epoch roots
    function setTrustedSettler(
        address newSettler
    ) external onlyContextAdmin {
        if (newSettler == address(0)) revert ZeroAddressSettler();
        address oldSettler = trustedSettler;
        trustedSettler = newSettler;
        emit SettlerUpdated(oldSettler, trustedSettler);
    }

    /// @notice Updates the string identifier of the reputation algorithm
    /// @param newAlgorithm The name or URI of the new algorithm
    function setReputationAlgorithm(
        string calldata newAlgorithm
    ) external onlyContextAdmin {
        _reputationAlgorithm = newAlgorithm;
    }

    /// @notice Updates the minimum threshold for a proposal to pass
    /// @param threshold The minimum voters for the new threshold
    function setQuorumThreshold(
        uint256 threshold
    ) external onlyContextAdmin {
        quorumThreshold = threshold;
    }

    /// @notice Retrieves a specific weight configuration version
    /// @param version The configuration version to query
    /// @param role The role to look up
    /// @return The weight for the role at that configuration version
    function getWeightAtVersion(
        uint32 version,
        bytes32 role
    ) external view returns (uint256) {
        return _weightHistory[version].weights[role];
    }

    /// @notice Retrieves the roles active at a specific configuration version
    /// @param version The configuration version to query
    /// @return Array of role identifiers
    function getRolesAtVersion(
        uint32 version
    ) external view returns (bytes32[] memory) {
        return _weightHistory[version].roles;
    }

    // REPUTATION SETTLEMENT ===================================================

    /// @notice Posts a new epoch root to the contract
    /// @param epoch The sequential epoch ID being settled
    /// @param merkleRoot The merkle root containing node state data
    /// @param treeURI URI pointing to the off-chain Merkle tree data
    /// @param sig EIP-712 signature from the trusted settler
    function postEpochRoot(
        uint256 epoch,
        bytes32 merkleRoot,
        string calldata treeURI,
        bytes calldata sig
    ) external payable {
        if (epoch != currentEpoch + 1) {
            revert InvalidEpoch(epoch, currentEpoch + 1);
        }
        if (epochRoots[epoch] != bytes32(0)) {
            revert EpochAlreadyPosted(epoch);
        }
        if (epochLength == 0) revert EpochLengthNotConfigured();
        if (disputeWindow == 0 || responseWindow == 0) revert DisputeWindowNotConfigured();
        if (epochLength <= disputeWindow + responseWindow) {
            revert WindowsExceedEpochLength(epochLength, disputeWindow, responseWindow);
        }
        if (settlementBond < MIN_SETTLEMENT_BOND) {
            revert BondBelowFloor(settlementBond, MIN_SETTLEMENT_BOND);
        }
        if (msg.value != settlementBond) {
            revert InsufficientBond(msg.value, settlementBond);
        }
        // The previous epoch (if any) must be fully finalized before this one can be posted —
        // this is what keeps settlement sequential now that a pending/challengeable state exists.
        if (epoch > 1) {
            if (!_isFinalized(currentEpoch)) revert EpochNotYetFinalized(currentEpoch);
            // Reaching here proves the previous epoch finalized without a rollback this cycle.
            consecutiveFailedEpochs = 0;
        }

        uint256 boundaryBlock = _boundaryBlockFor(epoch);
        if (block.number < boundaryBlock) {
            revert EpochNotYetElapsed(boundaryBlock, block.number);
        }

        bytes32 structHash = keccak256(
            abi.encode(
                SETTLE_ROOT_TYPEHASH, contextUID, epoch, merkleRoot, keccak256(bytes(treeURI))
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(trustedSettler, digest, sig)) {
            revert InvalidSettlerSignature();
        }

        currentEpoch = epoch;
        epochRoots[epoch] = merkleRoot;
        epochConfigVersion[epoch] = currentConfigVersion;
        epochPostedAtBlock[epoch] = block.number;
        epochBondAmount[epoch] = msg.value;

        emit EpochRootPosted(contextUID, epoch, merkleRoot, treeURI);
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
        if (!core.isRegistered(contextUID, node)) {
            revert NodeNotRegistered(contextUID, node);
        }
        if (epochRoots[epoch] == bytes32(0)) revert EpochNotFound(epoch);
        if (!_isFinalized(epoch)) revert EpochNotYetFinalized(epoch);
        if (epoch <= lastClaimedEpoch[node][role]) {
            revert AlreadyClaimed(node, role, epoch);
        }

        bytes32 leaf = _canonicalLeaf(node, role, score, epoch);
        if (!MerkleProof.verify(merkleProof, epochRoots[epoch], leaf)) {
            revert InvalidMerkleProof();
        }

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

    // B1 — NON-INCLUSION DISPUTES =============================================

    /// @inheritdoc IDRIFTSettler
    function challengeOmission(
        uint256 epoch,
        address missingNode
    ) external payable {
        if (epoch != currentEpoch) revert EpochNotFound(epoch);
        if (block.number > epochPostedAtBlock[epoch] + disputeWindow) {
            revert DisputeWindowClosed(epoch);
        }
        if (
            challenges[epoch][missingNode].openedAtBlock != 0
                && !challenges[epoch][missingNode].resolved
        ) {
            // A resolved (or never-opened) slot can be reused: this matters after a rollback and
            // repost of the same epoch number, where a fresh challenge against the same node must
            // be possible if the corrected root still omits them.
            revert ChallengeAlreadyOpen(epoch, missingNode);
        }
        if (!_disputeEligible(missingNode, _boundaryBlockFor(epoch))) {
            revert NodeNotEligibleForDispute(missingNode);
        }
        if (challengeBond < MIN_CHALLENGE_BOND) {
            revert BondBelowFloor(challengeBond, MIN_CHALLENGE_BOND);
        }
        if (msg.value != challengeBond) revert InsufficientBond(msg.value, challengeBond);

        challenges[epoch][missingNode] = Challenge({
            openedAtBlock: block.number, bond: msg.value, challenger: msg.sender, resolved: false
        });
        openChallengeCount[epoch]++;

        emit ChallengeOpened(contextUID, epoch, missingNode, msg.sender, msg.value);
    }

    /// @inheritdoc IDRIFTSettler
    function respondToChallenge(
        uint256 epoch,
        address node,
        bytes32 role,
        uint256 score,
        bytes32[] calldata merkleProof
    ) external {
        Challenge storage c = challenges[epoch][node];
        if (c.openedAtBlock == 0) revert ChallengeNotFound(epoch, node);
        if (c.resolved) revert ChallengeAlreadyResolved(epoch, node);
        if (epochRoots[epoch] == bytes32(0)) revert EpochAlreadyInvalidated(epoch);
        if (block.number > c.openedAtBlock + responseWindow) {
            revert ResponseWindowClosed(epoch, node);
        }

        bytes32 leaf = _canonicalLeaf(node, role, score, epoch);
        if (!MerkleProof.verify(merkleProof, epochRoots[epoch], leaf)) {
            revert InvalidMerkleProof();
        }

        c.resolved = true;
        openChallengeCount[epoch]--;
        uint256 bond = c.bond;
        c.bond = 0;

        (bool sent,) = trustedSettler.call{ value: bond }("");
        if (!sent) revert ExecutionFailed();

        emit ChallengeDefeated(contextUID, epoch, node);
    }

    /// @inheritdoc IDRIFTSettler
    function claimUnansweredChallenge(
        uint256 epoch,
        address node
    ) external {
        Challenge storage c = challenges[epoch][node];
        if (c.openedAtBlock == 0) revert ChallengeNotFound(epoch, node);
        if (c.resolved) revert ChallengeAlreadyResolved(epoch, node);
        if (epochRoots[epoch] == bytes32(0)) revert EpochAlreadyInvalidated(epoch);
        if (block.number <= c.openedAtBlock + responseWindow) {
            revert ResponseWindowStillOpen(epoch, node);
        }

        c.resolved = true;
        openChallengeCount[epoch]--;

        uint256 bond = epochBondAmount[epoch];
        epochBondAmount[epoch] = 0;
        epochRoots[epoch] = bytes32(0);
        epochPostedAtBlock[epoch] = 0;
        currentEpoch = epoch - 1;

        consecutiveFailedEpochs++;
        uint256 failCount = consecutiveFailedEpochs;

        address challenger = c.challenger;
        (bool sent,) = challenger.call{ value: bond }("");
        if (!sent) revert ExecutionFailed();

        emit NonInclusionProven(contextUID, epoch, node, challenger, bond, failCount);
    }

    /// @inheritdoc IDRIFTSettler
    function reclaimMootChallenge(
        uint256 epoch,
        address node
    ) external {
        Challenge storage c = challenges[epoch][node];
        if (c.openedAtBlock == 0) revert ChallengeNotFound(epoch, node);
        if (c.resolved) revert ChallengeAlreadyResolved(epoch, node);
        if (epochRoots[epoch] != bytes32(0)) revert EpochNotInvalidated(epoch);

        c.resolved = true;
        openChallengeCount[epoch]--;
        uint256 bond = c.bond;
        c.bond = 0;

        address challenger = c.challenger;
        (bool sent,) = challenger.call{ value: bond }("");
        if (!sent) revert ExecutionFailed();
    }

    /// @inheritdoc IDRIFTSettler
    function withdrawSettlementBond(
        uint256 epoch
    ) external {
        if (!_isFinalized(epoch)) revert EpochNotYetFinalized(epoch);
        uint256 bond = epochBondAmount[epoch];
        if (bond == 0) revert NoBondToWithdraw(epoch);

        epochBondAmount[epoch] = 0;

        (bool sent,) = trustedSettler.call{ value: bond }("");
        if (!sent) revert ExecutionFailed();

        emit SettlementBondWithdrawn(contextUID, epoch, bond);
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
        if (roles.length != scores.length || roles.length != proofs.length) {
            revert ArrayLengthMismatch();
        }
        if (!_isFinalized(currentEpoch)) revert EpochNotYetFinalized(currentEpoch);

        uint32 pinnedConfigVersion = epochConfigVersion[currentEpoch];
        WeightConfig storage pinnedConfig = _weightHistory[pinnedConfigVersion];

        uint256 proposerPower = 0;
        bytes32 root = epochRoots[currentEpoch];

        for (uint256 i = 0; i < roles.length; i++) {
            bytes32 role = roles[i];
            uint256 score = scores[i];

            bytes32 leaf = _canonicalLeaf(msg.sender, role, score, currentEpoch);
            if (!MerkleProof.verify(proofs[i], root, leaf)) {
                revert InvalidMerkleProof();
            }

            proposerPower += (score * pinnedConfig.weights[role]) / WEIGHT_SCALE;
        }

        if (proposerPower < proposalThreshold) revert BelowProposalThreshold();

        uint256 id = proposalCount++;
        Proposal storage p = proposals[id];

        p.description = description;
        p.deadline = block.timestamp + (durationInDays * 1 days);
        p.exists = true;
        p.target = target;
        p.payload = payload;
        p.snapshotEpoch = currentEpoch;
        p.configVersion = pinnedConfigVersion;

        emit ProposalCreated(id, description, p.deadline, p.snapshotEpoch, p.configVersion);
        return id;
    }

    /// @notice Executes a passed proposal
    /// @param proposalId The ID of the proposal to execute
    function executeProposal(
        uint256 proposalId
    ) external {
        Proposal storage p = proposals[proposalId];

        if (!p.exists) revert ProposalNotFound(proposalId);
        if (block.timestamp < p.deadline) revert VotingStillActive(p.deadline);
        if (p.votesFor <= p.votesAgainst) {
            revert ProposalDefeated(p.votesFor, p.votesAgainst);
        }
        if (p.executed) revert ProposalAlreadyExecuted(proposalId);
        if (p.votesFor + p.votesAgainst < quorumThreshold) {
            revert QuorumNotReached(p.votesFor + p.votesAgainst, quorumThreshold);
        }

        p.executed = true;

        (bool success,) = p.target.call(p.payload);
        if (!success) revert ExecutionFailed();
    }

    // GOVERNANCE: VOTING ======================================================

    /// @dev Disabled. All voting in this client requires Merkle state proofs.
    function castVote(
        uint256,
        bool
    ) external pure override {
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
        if (!_isFinalized(p.snapshotEpoch)) revert EpochNotYetFinalized(p.snapshotEpoch);

        uint256 totalPower = 0;

        for (uint256 i = 0; i < roles.length; i++) {
            bytes32 role = roles[i];

            uint256 weight = _weightHistory[p.configVersion].weights[role];
            if (weight == 0) revert RoleHasNoWeight(role);

            bytes32 leaf = _canonicalLeaf(msg.sender, role, scores[i], p.snapshotEpoch);
            if (!MerkleProof.verify(proofs[i], root, leaf)) {
                revert InvalidMerkleProof();
            }

            totalPower += (scores[i] * weight) / WEIGHT_SCALE;
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

    /// @notice Simulates voting power for a specific proposal using its snapshotted config version
    function getVotingPowerForProposal(
        uint256 proposalId,
        address account,
        bytes32[] calldata roles,
        uint256[] calldata scores,
        bytes32[][] calldata proofs
    ) external view returns (uint256 totalPower) {
        Proposal storage p = proposals[proposalId];
        if (!p.exists) revert ProposalNotFound(proposalId);

        bytes32 root = epochRoots[p.snapshotEpoch];
        if (root == bytes32(0)) revert EpochNotFound(p.snapshotEpoch);

        for (uint256 i = 0; i < roles.length; i++) {
            bytes32 leaf = _canonicalLeaf(account, roles[i], scores[i], p.snapshotEpoch);
            if (MerkleProof.verify(proofs[i], root, leaf)) {
                uint256 weight = _weightHistory[p.configVersion].weights[roles[i]];
                totalPower += (scores[i] * weight) / WEIGHT_SCALE;
            }
        }
    }

    /// @inheritdoc IDRIFTGovernanceProofOfState
    function getVotingPowerAtEpoch(
        address account,
        uint256 epoch,
        bytes32[] calldata roles,
        uint256[] calldata scores,
        bytes32[][] calldata proofs
    ) public view override returns (uint256 totalPower) {
        if (!core.isRegistered(contextUID, account)) return 0;
        if (roles.length != scores.length || roles.length != proofs.length) {
            revert ArrayLengthMismatch();
        }

        bytes32 root = epochRoots[epoch];
        if (root == bytes32(0)) revert EpochNotFound(epoch);
        if (!_isFinalized(epoch)) revert EpochNotYetFinalized(epoch);

        WeightConfig storage configAtEpoch = _weightHistory[epochConfigVersion[epoch]];

        for (uint256 i = 0; i < roles.length; i++) {
            bytes32 leaf = _canonicalLeaf(account, roles[i], scores[i], epoch);
            if (!MerkleProof.verify(proofs[i], root, leaf)) {
                revert InvalidMerkleProof();
            }
            totalPower += (scores[i] * configAtEpoch.weights[roles[i]]) / WEIGHT_SCALE;
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
    function hasVoted(
        uint256 proposalId,
        address account
    ) external view override returns (bool) {
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
        return (
            p.description,
            p.target,
            p.payload,
            p.votesFor,
            p.votesAgainst,
            p.deadline,
            p.executed,
            p.exists
        );
    }

    /// @notice Retrieves the snapshot configuration for a proposal
    /// @param proposalId The ID of the proposal
    /// @return snapshotEpoch The epoch the proposal was pinned to
    /// @return configVersion The weight configuration version at proposal creation
    function getProposalSnapshot(
        uint256 proposalId
    ) external view returns (uint256 snapshotEpoch, uint32 configVersion) {
        Proposal storage p = proposals[proposalId];
        return (p.snapshotEpoch, p.configVersion);
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
    function metadata()
        external
        pure
        override
        returns (string memory name, string memory description)
    {
        return ("Weighted Governance", "Multiplies ERC-1155 balances by configurable role weights.");
    }

    // INTERNAL ================================================================

    /// @notice Generates a standardized leaf hash for verifying Merkle proofs
    /// @param node Address of the node
    /// @param role Role being claimed or verified
    /// @param score The score or power associated with the claim
    /// @param epoch The epoch ID
    /// @return bytes32 double-hashed canonical leaf
    function _canonicalLeaf(
        address node,
        bytes32 role,
        uint256 score,
        uint256 epoch
    ) internal view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(contextUID, node, role, score, epoch))));
    }

    /// @notice The on-chain boundary block for `epoch`: h_0 + beta * epoch.
    function _boundaryBlockFor(
        uint256 epoch
    ) internal view returns (uint256) {
        return epochAnchorBlock + (epochLength * epoch);
    }

    /// @notice B1 dispute eligibility: `node` must have been registered at-or-before `boundary`
    ///         and not yet banned as of `boundary` — evaluated against registry state *as of the
    ///         boundary block*, not current status, so a ban applied after the fact can't strip a
    ///         legitimately-omitted node's standing to dispute (see DRIFTCoreStorage).
    function _disputeEligible(
        address node,
        uint256 boundary
    ) internal view returns (bool) {
        uint256 registeredAt = core.nodeRegisteredAtBlock(contextUID, node);
        if (registeredAt == 0 || registeredAt > boundary) return false;

        uint256 bannedAt = core.nodeBannedAtBlock(contextUID, node);
        if (bannedAt != 0 && bannedAt <= boundary) return false;

        return true;
    }

    /// @notice An epoch is finalized once its dispute+response windows have fully elapsed and no
    ///         challenge against it remains unresolved. `openChallengeCount == 0` matters even
    ///         after the time bound passes: a timed-out-but-not-yet-claimed challenge must not
    ///         let a genuinely bad epoch slip into use before its rollback actually executes.
    function _isFinalized(
        uint256 epoch
    ) internal view returns (bool) {
        return epochRoots[epoch] != bytes32(0)
            && block.number > epochPostedAtBlock[epoch] + disputeWindow + responseWindow
            && openChallengeCount[epoch] == 0;
    }
}
