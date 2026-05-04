// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import { IDRIFTCore } from "./IDRIFTCore.sol";
import { IAttestationProvider } from "../interfaces/IAttestationProvider.sol";
import { DRIFTCoreStorage } from "./DRIFTCoreStorage.sol";
import { DRIFTTypes } from "../Common.sol";
import { IDRIFTToken } from "../IDRIFTToken.sol";

/// @title  DRIFTCore
/// @notice Central DRIFT registry.
/// @dev    UUPS upgradeable. All storage declared in DRIFTCoreStorage.
contract DRIFTCore is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardTransient,
    UUPSUpgradeable,
    DRIFTCoreStorage,
    IDRIFTCore
{
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
    /// @notice Error thrown when an operation is done on a timelocked node
    error TimelockActive(bytes32 contextUID, address node);
    /// @notice Error thrown when
    error UnbondingPeriodActive(bytes32 contextUID, address node, uint256 unlockTime, uint256 currentTime);

    /// @notice Error thrown when a schema does not exist for a given context
    error SchemaNotFound(bytes32 contextUID, bytes32 schemaUID);

    /// @notice Error thrown when attempting to deregister twice
    error DeregistrationAlreadyRequested(bytes32 contextUID, address node);
    /// @notice Error thrown when
    error NoDeregistrationRequest(bytes32 contextUID, address node);
    /// @notice Error thrown when referencing an unregistered node
    error NodeNotRegistered(bytes32 contextUID, address node);
    /// @notice Error thrown when a registered nodes attempts to re-register
    error NodeAlreadyRegistered(bytes32 contextUID, address node);

    /// @notice Error thrown when a node's penalty exceeds his stake
    error PenaltyExceedsStake(bytes32 contextUID, address node, uint256 penalty);
    /// @notice Error thrown when stake below the minimum was provided
    error InsufficientStake(bytes32 contextUID, address node, uint256 provided, uint256 required);
    /// @notice Error thrown when staking in a context that does not a have a minimum stake
    error StakeNotRequired(bytes32 contextUID);

    /// @notice Error thrown
    error NativeTokenNotAccepted(bytes32 contextUID);
    /// @notice Error thrown when a token has already been set for the context
    error TokenAlreadySet();
    /// @notice Error thrown when an ether transfer fails
    error ETHTransferFailed();

    // Constants ===============================================================

    /// @notice Granted to addresses allowed to register contexts.
    ///         Granted to DRIFTClient contracts by the admin post-deploy.
    bytes32 public constant CLIENT_ROLE = keccak256("CLIENT_ROLE");

    /// @notice How long a node must wait between requesting and executing
    ///         deregistration. Prevents stake-then-slash-then-exit attacks.
    uint256 public constant UNBONDING_PERIOD = 7 days;

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
    function registerContext(
        string calldata name,
        address stakeToken,
        uint256 minimumStake
    ) external onlyRole(CLIENT_ROLE) returns (bytes32 uid) {
        if (bytes(name).length == 0) {
            revert EmptyContextName();
        }

        uid = keccak256(abi.encodePacked(name));

        if (_usedNames[uid]) {
            revert ContextTaken(uid);
        }

        _usedNames[uid] = true;

        // If a stake is required, a token must be specified (or ETH via address(0))
        if (minimumStake > 0) {
            // address(0) means native ETH
        }

        _contexts[uid] = DRIFTTypes.Context({
            uid: uid,
            name: name,
            owner: msg.sender,
            active: true,
            stakeToken: stakeToken,
            minimumStake: minimumStake
        });

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
        DRIFTTypes.Context memory ctx = _contexts[contextUID];
        if (!ctx.active) {
            revert ContextNotActive(contextUID);
        }

        if (_stakes[contextUID][msg.sender] != 0) {
            revert NodeAlreadyRegistered(contextUID, msg.sender);
        }

        if (_unlockTimes[contextUID][msg.sender] != 0) {
            revert TimelockActive(contextUID, msg.sender);
        }

        uint256 staked;

        if (ctx.minimumStake > 0) {
            if (ctx.stakeToken == address(0)) {
                // Native ETH
                if (msg.value < ctx.minimumStake) {
                    revert InsufficientStake(contextUID, msg.sender, msg.value, ctx.minimumStake);
                }
                staked = msg.value;
            } else {
                // ERC-20 — caller must have approved DRIFTCore first
                if (msg.value != 0) {
                    revert NativeTokenNotAccepted(contextUID);
                }
                IERC20(ctx.stakeToken).transferFrom(msg.sender, address(this), ctx.minimumStake);
                staked = ctx.minimumStake;
            }
        } else {
            if (msg.value != 0) {
                revert StakeNotRequired(contextUID);
            }
            staked = 1; // sentinel: registered with no stake
        }

        _stakes[contextUID][msg.sender] = staked;

        emit NodeRegistered(contextUID, msg.sender, staked);
    }

    /// @inheritdoc IDRIFTCore
    /// @dev Two-step deregistration prevents stake-then-exit-before-slash.
    ///      Step 1: requestDeregister — locks stake, starts unbonding timer.
    ///      Step 2: executeDeregister — callable after UNBONDING_PERIOD.
    function requestDeregister(bytes32 contextUID) external {
        if (_stakes[contextUID][msg.sender] == 0) {
            revert NodeNotRegistered(contextUID, msg.sender);
        }
        if (_unlockTimes[contextUID][msg.sender] != 0) {
            revert DeregistrationAlreadyRequested(contextUID, msg.sender);
        }

        uint256 unlockAt = block.timestamp + UNBONDING_PERIOD;
        _unlockTimes[contextUID][msg.sender] = unlockAt;

        emit DeregisterRequested(contextUID, msg.sender, unlockAt);
    }

    /// @inheritdoc IDRIFTCore
    function executeDeregister(bytes32 contextUID) external nonReentrant {
        uint256 unlockAt = _unlockTimes[contextUID][msg.sender];
        if (unlockAt == 0) {
            revert NoDeregistrationRequest(contextUID, msg.sender);
        }
        if (block.timestamp < unlockAt) {
            revert UnbondingPeriodActive(contextUID, msg.sender, unlockAt, block.timestamp);
        }

        uint256 staked = _stakes[contextUID][msg.sender];
        DRIFTTypes.Context memory ctx = _contexts[contextUID];

        delete _stakes[contextUID][msg.sender];
        delete _unlockTimes[contextUID][msg.sender];

        // Return stake if one was actually held (not the sentinel value 1)
        if (staked > 1) {
            if (ctx.stakeToken == address(0)) {
                (bool ok, ) = msg.sender.call{ value: staked }("");
                if (!ok) {
                    revert ETHTransferFailed();
                }
            } else {
                IERC20(ctx.stakeToken).transfer(msg.sender, staked);
            }
        }

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
        if (_stakes[contextUID][attester] == 0) return false;

        // must be a registered node in this context
        if (_stakes[contextUID][subject] == 0) return false;

        address adapter = _schemaAdapters[contextUID][schemaUID];
        if (adapter == address(0)) return false;
        return IAttestationProvider(adapter).isValid(attestationUID, schemaUID, subject);
    }

    // Cryptoeconomic Enforcement ==============================================

    /// @inheritdoc IDRIFTCore
    function slash(bytes32 contextUID, address node, uint256 penaltyAmount) external onlyContextAdmin(contextUID) {
        uint256 currentStake = _stakes[contextUID][node];
        if (currentStake == 0) revert NodeNotRegistered(contextUID, node);
        if (currentStake < penaltyAmount) revert PenaltyExceedsStake(contextUID, node, penaltyAmount);

        // Deduct the penalty
        uint256 newStake = currentStake - penaltyAmount;

        if (newStake == 0) {
            delete _stakes[contextUID][node];
            delete _unlockTimes[contextUID][node];
            emit NodeDeregistered(contextUID, node);
        } else {
            _stakes[contextUID][node] = newStake;
        }

        uint256 tokenId = uint256(contextUID);

        // BUG: do we slash reputation AND eth?

        driftToken.slashReputation(node, tokenId, penaltyAmount);

        (bool success, ) = BURN_ADDRESS.call{ value: penaltyAmount }("");
        if (!success) revert ETHTransferFailed();

        emit NodeSlashed(contextUID, node, penaltyAmount);
    }

    /// @inheritdoc IDRIFTCore
    function reward(bytes32 contextUID, address node, uint256 reputationAmount) external onlyContextAdmin(contextUID) {
        if (_stakes[contextUID][node] == 0) revert NodeNotRegistered(contextUID, node);

        // Cast Context UID to Token ID
        uint256 tokenId = uint256(contextUID);

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
    function getStake(bytes32 contextUID, address node) external view returns (uint256) {
        return _stakes[contextUID][node];
    }

    /// @inheritdoc IDRIFTCore
    function stakedAmount(bytes32 contextUID, address node) external view returns (uint256) {
        uint256 staked = _stakes[contextUID][node];
        // Hide the sentinel value from external callers
        return staked == 1 ? 0 : staked;
    }

    /// @inheritdoc IDRIFTCore
    function isRegistered(bytes32 contextUID, address node) external view returns (bool) {
        return _stakes[contextUID][node] > 0;
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
