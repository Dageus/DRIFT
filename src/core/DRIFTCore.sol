// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import { IDRIFTCore } from "./IDRIFTCore.sol";
import { IAttestationProvider } from "../interfaces/IAttestationProvider.sol";
import { DRIFTCoreStorage } from "./DRIFTCoreStorage.sol";
import { DRIFTTypes } from "../Common.sol";
import { IDRIFTToken } from "../IDRIFTToken.sol";

/// @title  DRIFTCore
/// @notice Central DRIFT registry.
/// @dev    UUPS upgradeable. All storage declared in DRIFTCoreStorage.
contract DRIFTCore is Initializable, AccessControlUpgradeable, UUPSUpgradeable, DRIFTCoreStorage, IDRIFTCore {
    // Errors ==================================================================

    /// @notice Error thrown when a context name is taken
    error ContextTaken(bytes32 contextUID);
    /// @notice Error thrown when a context is inactive
    error ContextNotActive(bytes32 contextUID);
    /// @notice Error thrown when performing operations on an unknown context
    error ContextNotFound(bytes32 contextUID);
    /// @notice Error thrown when registering an empty context name
    error EmptyContextName();

    /// @notice Error thrown when attempting to register an invalid adapter address
    error InvalidAdapterAddress(bytes32 contextUID);
    /// @notice Error thrown when attempting to register an invalid schema UID
    error InvalidSchemaUID(bytes32 contextUID);

    /// @notice Error thrown when a caller doesn't have the minimum role
    error UnauthorizedCaller(bytes32 role, address caller);

    /// @notice Error thrown when a schema does not exist for a given context
    error SchemaNotFound(bytes32 contextUID, bytes32 schemaUID);

    /// @notice Error thrown when referencing an unregistered node
    error NodeNotRegistered(bytes32 contextUID, address node);
    /// @notice Error thrown when a registered nodes attempts to re-register
    error NodeAlreadyRegistered(bytes32 contextUID, address node);

    /// @notice Error thrown when a token has already been set for the context
    error TokenAlreadySet();

    // Constants ===============================================================

    /// @notice Granted to addresses allowed to register contexts.
    ///         Granted to DRIFTClient contracts by the admin post-deploy.
    bytes32 public constant CLIENT_ROLE = keccak256("CLIENT_ROLE");

    // Token Management ========================================================

    IDRIFTToken public driftToken;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Links the ERC-1155 token to the core registry.
    function setDriftToken(address _tokenAddress) external {
        _checkRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (address(driftToken) != address(0)) revert TokenAlreadySet();

        driftToken = IDRIFTToken(_tokenAddress);
    }

    // Constructor =============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializer — replaces constructor for upgradeable contracts.
    /// @param  admin  Receives DEFAULT_ADMIN_ROLE. Can upgrade and grant roles.
    function initialize(address admin) external initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        // self-governance
        // _registerContext("DRIFT.Governance", address(0), 0);
    }

    // Context management ======================================================

    /// @inheritdoc IDRIFTCore
    function registerContext(string calldata name) external onlyRole(CLIENT_ROLE) returns (bytes32 uid) {
        if (bytes(name).length == 0) {
            revert EmptyContextName();
        }

        uid = keccak256(abi.encodePacked(name));

        if (_usedNames[uid]) {
            revert ContextTaken(uid);
        }

        _usedNames[uid] = true;

        _contexts[uid] = DRIFTTypes.Context({ uid: uid, name: name, owner: msg.sender, active: true });

        _grantRole(contextAdminRole(uid), msg.sender);

        emit ContextRegistered(uid, name, msg.sender);
    }

    /// @inheritdoc IDRIFTCore
    function deactivateContext(bytes32 contextUID) external onlyContextAdmin(contextUID) {
        _contexts[contextUID].active = false;
        emit ContextDeactivated(contextUID);
    }

    /// @inheritdoc IDRIFTCore
    function contextAdminRole(bytes32 contextUID) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("CONTEXT_ADMIN", contextUID));
    }

    // Schema management =======================================================

    /// @inheritdoc IDRIFTCore
    function addSchema(bytes32 contextUID, bytes32 schemaUID, address adapter) external onlyContextAdmin(contextUID) {
        if (adapter == address(0)) {
            revert InvalidAdapterAddress(contextUID);
        }
        if (schemaUID == bytes32(0)) {
            revert InvalidSchemaUID(contextUID);
        }

        _acceptedSchemas[contextUID][schemaUID] = true;
        _schemaAdapters[contextUID][schemaUID] = adapter;

        emit SchemaAdded(contextUID, schemaUID, adapter);
    }

    /// @inheritdoc IDRIFTCore
    function removeSchema(bytes32 contextUID, bytes32 schemaUID) external onlyContextAdmin(contextUID) {
        if (!_acceptedSchemas[contextUID][schemaUID]) {
            revert SchemaNotFound(contextUID, schemaUID);
        }

        delete _acceptedSchemas[contextUID][schemaUID];
        delete _schemaAdapters[contextUID][schemaUID];

        emit SchemaRemoved(contextUID, schemaUID);
    }

    // Node registration =======================================================

    /// @inheritdoc IDRIFTCore
    function registerNode(bytes32 contextUID) external payable {
        if (!_contexts[contextUID].active) {
            revert ContextNotActive(contextUID);
        }

        if (_isRegistered[contextUID][msg.sender]) {
            revert NodeAlreadyRegistered(contextUID, msg.sender);
        }

        _isRegistered[contextUID][msg.sender] = true;

        emit NodeRegistered(contextUID, msg.sender);
    }

    /// @inheritdoc IDRIFTCore
    function deregisterNode(bytes32 contextUID) external {
        if (!_isRegistered[contextUID][msg.sender]) revert NodeNotRegistered(contextUID, msg.sender);

        _isRegistered[contextUID][msg.sender] = false;
        emit NodeDeregistered(contextUID, msg.sender);
    }

    // Trust verification ======================================================

    /// @inheritdoc IDRIFTCore
    function verifyAttestation(
        bytes32 contextUID,
        bytes32 schemaUID,
        bytes32 attestationUID,
        address subject,
        address attester
    ) external view returns (bool) {
        // must be active
        if (!_contexts[contextUID].active) return false;

        // must be accepted in this context
        if (!_acceptedSchemas[contextUID][schemaUID]) return false;

        // must be a registered node in this context
        if (!_isRegistered[contextUID][attester]) return false;

        // must be a registered node in this context
        if (!_isRegistered[contextUID][subject]) return false;

        address adapter = _schemaAdapters[contextUID][schemaUID];
        if (adapter == address(0)) return false;
        return IAttestationProvider(adapter).isValid(attestationUID, schemaUID, subject);
    }

    // Cryptoeconomic Enforcement ==============================================

    /// @inheritdoc IDRIFTCore
    function slash(
        bytes32 contextUID,
        bytes32 role,
        address node,
        uint256 penaltyAmount
    ) external onlyContextAdmin(contextUID) {
        if (!_isRegistered[contextUID][node]) revert NodeNotRegistered(contextUID, node);

        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, role)));

        _isRegistered[contextUID][node] = false;

        driftToken.slashReputation(node, tokenId, penaltyAmount);

        emit NodeSlashed(contextUID, node, penaltyAmount);

        // TODO:
        // is a node eligible to be unregistered if his reputation is low enough?
    }

    /// @inheritdoc IDRIFTCore
    function reward(
        bytes32 contextUID,
        bytes32 role,
        address node,
        uint256 reputationAmount
    ) external onlyContextAdmin(contextUID) {
        if (!_isRegistered[contextUID][node]) revert NodeNotRegistered(contextUID, node);

        // Cast Context UID to Token ID
        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, role)));

        // Mint reputation
        driftToken.rewardReputation(node, tokenId, reputationAmount);

        emit NodeRewarded(contextUID, node);
    }

    // Views ===================================================================

    /// @inheritdoc IDRIFTCore
    function getContext(bytes32 uid) external view returns (DRIFTTypes.Context memory) {
        if (!_contextExists(uid)) {
            revert ContextNotFound(uid);
        }
        return _contexts[uid];
    }

    /// @inheritdoc IDRIFTCore
    function getAdapter(bytes32 contextUID, bytes32 schemaUID) external view returns (address) {
        return _schemaAdapters[contextUID][schemaUID];
    }

    /// @inheritdoc IDRIFTCore
    function isRegistered(bytes32 contextUID, address node) external view returns (bool) {
        return _isRegistered[contextUID][node];
    }

    /// @inheritdoc IDRIFTCore
    function contextExists(bytes32 uid) external view returns (bool) {
        return _contextExists(uid);
    }

    // Modifiers ===============================================================

    modifier onlyContextAdmin(bytes32 contextUID) {
        if (!_contextExists(contextUID)) {
            revert ContextNotFound(contextUID);
        }
        _checkRole(contextAdminRole(contextUID), msg.sender);
        _;
    }

    // Helpers =================================================================

    function _contextExists(bytes32 contextUID) internal view returns (bool) {
        // If the uid matches what was passed, it was initialized
        return _contexts[contextUID].uid == contextUID;
    }

    // UUPS ====================================================================

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
