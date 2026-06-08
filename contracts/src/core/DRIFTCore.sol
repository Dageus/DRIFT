// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import { IDRIFTCore } from "./IDRIFTCore.sol";
import { IAttestationProvider } from "../providers/IAttestationProvider.sol";
import { DRIFTCoreStorage } from "./DRIFTCoreStorage.sol";
import { DRIFTTypes } from "../Common.sol";
import { IDRIFTToken } from "../token/IDRIFTToken.sol";
import { IPolicy, NodeStatus } from "../policies/IPolicy.sol";

/// @title  DRIFTCore
/// @notice Central DRIFT registry.
/// @dev    UUPS upgradeable. All storage declared in DRIFTCoreStorage.
contract DRIFTCore is Initializable, DRIFTCoreStorage, AccessControlUpgradeable, UUPSUpgradeable, IDRIFTCore {
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

    /// @notice Error thrown when a caller doesn't have the required permissions
    error UnauthorizedCaller(address caller);

    /// @notice Error thrown when a schema does not exist for a given context
    error SchemaNotFound(bytes32 contextUID, bytes32 schemaUID);

    /// @notice Error thrown when referencing an unregistered node
    error NodeNotRegistered(bytes32 contextUID, address node);
    /// @notice Error thrown when a registered nodes attempts to re-register
    error NodeAlreadyRegistered(bytes32 contextUID, address node);

    /// @notice Error thrown when a token has already been set for the context
    error TokenAlreadySet();

    // Token Management ========================================================

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    bytes32 public constant FACTORY_ROLE = keccak256("FACTORY_ROLE");

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
    }

    // DRIFT Token =============================================================

    /// @notice Links the ERC-1155 token to the core registry.
    function setDriftToken(address _tokenAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(driftToken) != address(0)) revert TokenAlreadySet();

        driftToken = IDRIFTToken(_tokenAddress);
    }

    // Context management ======================================================

    /// @inheritdoc IDRIFTCore
    function registerContext(string calldata name) external returns (bytes32 uid) {
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

    // Policy management =======================================================

    /// @inheritdoc IDRIFTCore
    function setContextPolicy(bytes32 contextUID, address policyContract) external onlyContextAdmin(contextUID) {
        _contextPolicies[contextUID] = policyContract;

        emit PolicyUpdated(contextUID, policyContract);
    }

    // Client management =======================================================

    /// @inheritdoc IDRIFTCore
    // WARNING: shouldn't the factory be the only one allowed to do this?
    function setContextClient(bytes32 contextUID, address clientContract) external onlyRole(FACTORY_ROLE) {
        _contextClients[contextUID] = clientContract;

        emit ClientUpdated(contextUID, clientContract);
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

    // Node management =========================================================

    /// @inheritdoc IDRIFTCore
    function registerNode(bytes32 contextUID, bytes calldata entryProof) external {
        if (!_contexts[contextUID].active) {
            revert ContextNotActive(contextUID);
        }
        if (nodeStatus[contextUID][msg.sender] != NodeStatus.NONE) {
            revert NodeAlreadyRegistered(contextUID, msg.sender);
        }

        address policyAddress = _contextPolicies[contextUID];
        NodeStatus status = NodeStatus.FULL;

        if (policyAddress != address(0)) {
            status = IPolicy(policyAddress).evaluate(msg.sender, contextUID, entryProof);
            require(status != NodeStatus.NONE, "Policy rejected entry");
        } else {
            // If there's no entry policy, fallback checking if there's any required native token stake
            // configured for open registration
        }

        nodeStatus[contextUID][msg.sender] = status;

        emit NodeRegistered(contextUID, msg.sender);
    }

    /// @inheritdoc IDRIFTCore
    function deregisterNode(bytes32 contextUID) external {
        if (nodeStatus[contextUID][msg.sender] == NodeStatus.NONE) {
            revert NodeNotRegistered(contextUID, msg.sender);
        }
        if (nodeStatus[contextUID][msg.sender] == NodeStatus.BANNED) {
            revert("Banned nodes cannot deregister");
        }

        delete nodeStatus[contextUID][msg.sender];

        // BUG: what about the reputation tokens of that user?

        emit NodeDeregistered(contextUID, msg.sender);
    }

    function setNodeStatus(
        bytes32 contextUID,
        address node,
        NodeStatus newStatus
    ) external onlyContextAdmin(contextUID) {
        if (nodeStatus[contextUID][node] == NodeStatus.BANNED) revert("Cannot unban node via status update");
        nodeStatus[contextUID][node] = newStatus;
        // Emit custom status transition event
        emit NodeStatusUpdated(contextUID, node, newStatus);
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

        NodeStatus attesterStatus = nodeStatus[contextUID][attester];
        NodeStatus subjectStatus = nodeStatus[contextUID][subject];

        if (attesterStatus == NodeStatus.NONE || attesterStatus == NodeStatus.BANNED) return false;
        if (subjectStatus == NodeStatus.NONE || subjectStatus == NodeStatus.BANNED) return false;

        address adapter = _schemaAdapters[contextUID][schemaUID];
        if (adapter == address(0)) return false;
        return IAttestationProvider(adapter).isValid(attestationUID, schemaUID, subject);
    }

    // Cryptoeconomic enforcement ==============================================

    /// @inheritdoc IDRIFTCore
    function slash(
        bytes32 contextUID,
        bytes32 role,
        address node,
        uint256 penaltyAmount
    ) external onlyContextClient(contextUID) {
        NodeStatus status = nodeStatus[contextUID][node];
        if (status == NodeStatus.NONE || status == NodeStatus.BANNED) {
            revert NodeNotRegistered(contextUID, node);
        }

        uint256 tokenId = uint256(keccak256(abi.encode(contextUID, role)));
        driftToken.slashReputation(node, tokenId, penaltyAmount);

        emit NodeSlashed(contextUID, node, penaltyAmount);
    }

    /// @inheritdoc IDRIFTCore
    function reward(
        bytes32 contextUID,
        bytes32 role,
        address node,
        uint256 reputationAmount
    ) external onlyContextClient(contextUID) {
        NodeStatus status = nodeStatus[contextUID][node];
        if (status == NodeStatus.NONE || status == NodeStatus.BANNED) revert NodeNotRegistered(contextUID, node);

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
    function getContextClient(bytes32 contextUID) external view returns (address) {
        return _contextClients[contextUID];
    }

    /// @inheritdoc IDRIFTCore
    function isRegistered(bytes32 contextUID, address node) external view returns (bool) {
        NodeStatus status = nodeStatus[contextUID][node];
        return (status != NodeStatus.NONE && status != NodeStatus.BANNED);
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

    modifier onlyContextClient(bytes32 contextUID) {
        if (msg.sender != _contextClients[contextUID]) {
            revert UnauthorizedCaller(msg.sender);
        }
        _;
    }

    // Helpers =================================================================

    function _contextExists(bytes32 contextUID) internal view returns (bool) {
        return _contexts[contextUID].uid == contextUID;
    }

    // UUPS ====================================================================

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
