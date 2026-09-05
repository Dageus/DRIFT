// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTClient } from "./IDRIFTClient.sol";

/// @title IDRIFTSettler
/// @notice Capability to accept signed reputation scores and forward them to the Core.
interface IDRIFTSettler is IDRIFTClient {
    // EVENTS ==================================================================

    /// @notice Emitted when the trusted settler address is changed
    event SettlerUpdated(address indexed oldSettler, address indexed newSettler);

    /// @notice Emitted when a new epoch root is posted
    event EpochRootPosted(
        bytes32 indexed contextUID, uint256 indexed epoch, bytes32 merkleRoot, string treeURI
    );

    /// @notice Emitted when a node successfully claims its reputation for an epoch
    event ReputationClaimed(
        bytes32 indexed contextUID,
        address indexed node,
        bytes32 indexed role,
        uint256 score,
        uint256 epoch
    );

    /// @notice Emitted when a non-inclusion challenge is opened against an epoch (B1)
    event ChallengeOpened(
        bytes32 indexed contextUID,
        uint256 indexed epoch,
        address indexed missingNode,
        address challenger,
        uint256 bond
    );

    /// @notice Emitted when a challenge is defeated by a valid inclusion proof (B1)
    event ChallengeDefeated(
        bytes32 indexed contextUID, uint256 indexed epoch, address indexed missingNode
    );

    /// @notice Emitted when a challenge goes unanswered and the epoch root is invalidated (B1)
    event NonInclusionProven(
        bytes32 indexed contextUID,
        uint256 indexed epoch,
        address indexed missingNode,
        address disputer,
        uint256 bondPaid,
        uint256 consecutiveFailedEpochs
    );

    /// @notice Emitted when the settler's escrowed bond for a cleanly-finalized epoch is withdrawn (B1)
    event SettlementBondWithdrawn(
        bytes32 indexed contextUID, uint256 indexed epoch, uint256 amount
    );

    // ERRORS ==================================================================

    error InvalidSettlerSignature();
    error EpochAlreadyPosted(uint256 epoch);
    error EpochNotFound(uint256 epoch);
    error AlreadyClaimed(address node, bytes32 role, uint256 epoch);
    error InvalidMerkleProof();

    // B1 — non-inclusion disputes =============================================

    error DisputeWindowNotConfigured();
    error DisputeWindowAlreadySet();
    error InvalidDisputeWindow();
    error ResponseWindowAlreadySet();
    error InvalidResponseWindow();
    error WindowsExceedEpochLength(
        uint256 epochLength, uint256 disputeWindow, uint256 responseWindow
    );
    error BondBelowFloor(uint256 provided, uint256 floor);
    error InsufficientBond(uint256 provided, uint256 required);
    error EpochNotYetFinalized(uint256 epoch);
    error NodeNotEligibleForDispute(address node);
    error DisputeWindowClosed(uint256 epoch);
    error ResponseWindowClosed(uint256 epoch, address node);
    error ResponseWindowStillOpen(uint256 epoch, address node);
    error ChallengeNotFound(uint256 epoch, address node);
    error ChallengeAlreadyOpen(uint256 epoch, address node);
    error ChallengeAlreadyResolved(uint256 epoch, address node);
    error EpochAlreadyInvalidated(uint256 epoch);
    error EpochNotInvalidated(uint256 epoch);
    error NoBondToWithdraw(uint256 epoch);

    // SETTLEMENT CONFIGURATION ================================================

    /// @notice Rotates the trusted settler key. Must be called by the context admin.
    /// @param newSettler The new address authorized to sign epoch roots
    function setTrustedSettler(
        address newSettler
    ) external;

    // EPOCH & REPUTATION MANAGEMENT ===========================================

    /// @notice Posts a new epoch root verified by the trusted settler
    /// @dev Payable: the caller must escrow `settlementBond` wei (B1), forfeited to a successful
    ///      challenger if the epoch's non-inclusion challenge window times out unanswered.
    /// @param epoch The sequential epoch ID
    /// @param merkleRoot The root of the reputation Merkle tree
    /// @param sig EIP-712 signature from the trusted settler
    function postEpochRoot(
        uint256 epoch,
        bytes32 merkleRoot,
        string calldata treeURI,
        bytes calldata sig
    ) external payable;

    /// @notice Claims reputation tokens for a node based on a settled epoch root
    /// @param node Address of the node
    /// @param role Role being claimed
    /// @param score Target reputation score
    /// @param epoch Epoch ID being claimed
    /// @param merkleProof Proof validating the claim against the epoch root
    function claimReputation(
        address node,
        bytes32 role,
        uint256 score,
        uint256 epoch,
        bytes32[] calldata merkleProof
    ) external;

    /// @notice Verifies a reputation proof without making any state changes. Useful for SDK pre-flight checks.
    /// @param node Address of the node
    /// @param role Role being verified
    /// @param score The score being verified
    /// @param epoch The epoch ID to check against
    /// @param merkleProof Proof validating the state
    /// @return True if the proof is valid, false otherwise
    function verifyReputation(
        address node,
        bytes32 role,
        uint256 score,
        uint256 epoch,
        bytes32[] calldata merkleProof
    ) external view returns (bool);

    // B1 — NON-INCLUSION DISPUTES =============================================

    /// @notice Opens a challenge claiming `missingNode` was admitted at `epoch`'s boundary but has
    ///         no leaf in that epoch's posted root. Caller must escrow `challengeBond` wei.
    /// @param epoch The (current) epoch being challenged
    /// @param missingNode The node claimed to be omitted
    function challengeOmission(
        uint256 epoch,
        address missingNode
    ) external payable;

    /// @notice Defeats an open challenge by proving `node` does have a leaf in `epoch`'s root.
    ///         Permissionless — callable by anyone with the published tree data — but the
    ///         challenger's forfeited bond always pays out to the context's trustedSettler.
    function respondToChallenge(
        uint256 epoch,
        address node,
        bytes32 role,
        uint256 score,
        bytes32[] calldata merkleProof
    ) external;

    /// @notice Finalizes an unanswered challenge once its response window has elapsed: the
    ///         settler's bond is forfeited to the original challenger and the epoch root is
    ///         invalidated (rolled back) for correction. Permissionless trigger.
    function claimUnansweredChallenge(
        uint256 epoch,
        address node
    ) external;

    /// @notice Refunds a challenger's own bond for a challenge rendered moot by a *different*
    ///         concurrent challenge against the same epoch already invalidating its root.
    function reclaimMootChallenge(
        uint256 epoch,
        address node
    ) external;

    /// @notice Batched reclaimMootChallenge: refunds several moot challenges' bonds in one
    ///         transaction, amortizing the fixed transaction overhead a caller would otherwise
    ///         pay per reclaim. `epochs[i]`/`nodes[i]` are paired positionally. Reverts the whole
    ///         batch if any entry is not currently reclaimable.
    function reclaimMootChallenges(
        uint256[] calldata epochs,
        address[] calldata nodes
    ) external;

    /// @notice Withdraws the settler's escrowed bond for an epoch that finalized cleanly
    ///         (window elapsed, no successful challenge). Callable by anyone; pays trustedSettler.
    function withdrawSettlementBond(
        uint256 epoch
    ) external;
}
