// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTTypes } from "../Common.sol";

/// @title  IDRIFTCore
/// @notice DRIFT - Decentralized Reputation Infrastructure for Trust interface
interface IDRIFTCore {
    // Events ==================================================================

    /// @notice Emitted when a new context is registered.
    event ContextRegistered(bytes32 indexed uid, string name, address indexed owner);

    /// @notice Emitted when a context is deactivated.
    event ContextDeactivated(bytes32 indexed uid);

    /// @notice Emitted when a schema is added to a context.
    event SchemaAdded(bytes32 indexed contextUID, bytes32 indexed schemaUID, address indexed adapter);

    /// @notice Emitted when a schema is removed from a context.
    event SchemaRemoved(bytes32 indexed contextUID, bytes32 indexed schemaUID);

    /// @notice Emitted when a node registers into a context.
    event NodeRegistered(bytes32 indexed contextUID, address indexed node, uint256 stakedAmount);

    /// @notice Emitted when a node requests a deregister.
    event DeregisterRequested(bytes32 indexed contextUID, address indexed node, uint256 unlockAt);

    /// @notice Emitted when a node withdraws and leaves a context.
    event NodeDeregistered(bytes32 indexed contextUID, address indexed node);

    /// @notice Emitted when a node gets slashed.
    event NodeSlashed(bytes32 indexed contextUID, address indexed node, uint256 penalty);

    /// @notice Emitted when a node gets rewarded
    event NodeRewarded(bytes32 indexed contextUID, address indexed node);

    // Context management ======================================================

    /// @notice Register a new reputation context.
    /// @param  name          Human-readable name, unique per owner.
    /// @param  stakeToken    ERC-20 token used for stake. address(0) for ETH.
    /// @param  minimumStake  Minimum stake required to join. 0 for no requirement.
    /// @return uid           The context's unique identifier.
    function registerContext(
        string calldata name,
        address stakeToken,
        uint256 minimumStake
    ) external returns (bytes32 uid);

    /// @notice Deactivate a context. Existing node stakes are preserved.
    function deactivateContext(bytes32 contextUID) external;

    /// @notice Return a unique Admin role for the given contextUID
    function contextAdminRole(bytes32 contextUID) external pure returns (bytes32);

    // Schema management =======================================================

    /// @notice Add an accepted schema to a context.
    /// @param  contextUID  The context to configure.
    /// @param  schemaUID   Schema UID as registered in the attestation provider.
    /// @param  adapter     IAttestationProvider that can verify this schema.
    function addSchema(bytes32 contextUID, bytes32 schemaUID, address adapter) external;

    /// @notice Remove a schema from a context.
    ///         Existing attestations are unaffected — only future
    ///         verifications will reject this schema.
    function removeSchema(bytes32 contextUID, bytes32 schemaUID) external;

    // Node registration =======================================================

    /// @notice Register as a participant in a context.
    ///         Caller must provide the required stake.
    ///         After registration, this node may attest about other
    ///         registered nodes and receive attestations from them.
    ///         Emits NodeRegistered.
    /// @param  contextUID  The context to join.
    function registerNode(bytes32 contextUID) external payable;

    /// @notice Request deregister from a context and lock stake.
    ///         Node's past attestations remain in EAS but will be
    ///         ignored by the off-chain indexer going forward.
    function requestDeregister(bytes32 contextUID) external;

    /// @notice Deregister from a context and withdraw stake.
    ///         Node's past attestations remain in EAS but will be
    ///         ignored by the off-chain indexer going forward.
    function executeDeregister(bytes32 contextUID) external;

    // Trust verification ======================================================

    /// @notice The core on-chain primitive.
    /// @param  contextUID      The context to verify within.
    /// @param  schemaUID       Expected schema of the attestation.
    /// @param  attestationUID  The attestation to verify (lives in EAS).
    /// @param  subject         The address the attestation is about.
    /// @param  attester        The address that submitted the attestation.
    /// @return                 True if all checks pass.
    function verifyAttestation(
        bytes32 contextUID,
        bytes32 schemaUID,
        bytes32 attestationUID,
        address subject,
        address attester
    ) external view returns (bool);

    // Cryptoeconomic Enforcement ==============================================

    /// @notice Slashes a registered node's stake.
    ///         Only callable by the context administrator.
    function slash(bytes32 contextUID, address node, uint256 penaltyAmount) external;

    /// @notice Rewards a node (placeholder for MVP).
    ///         Only callable by the context administrator.
    function reward(bytes32 contextUID, address node, uint256 reputationAmount) external;

    // Views ===================================================================

    /// @notice Returns the full context record.
    function getContext(bytes32 uid) external view returns (DRIFTTypes.Context memory);

    /// @notice Returns the adapter for the given schema.
    function getAdapter(bytes32 contextUID, bytes32 schemaUID) external view returns (address);

    /// @notice Returns the financial stake of node in context.
    function getStake(bytes32 contextUID, address node) external view returns (uint256);

    /// @notice Returns the staked amount for a node in a context.
    ///         Returns 0 if not registered.
    function stakedAmount(bytes32 contextUID, address node) external view returns (uint256);

    /// @notice Returns true if a node is registered in a context.
    function isRegistered(bytes32 contextUID, address node) external view returns (bool);

    /// @notice Returns true if a context exists and is active.
    function contextExists(bytes32 uid) external view returns (bool);
}
