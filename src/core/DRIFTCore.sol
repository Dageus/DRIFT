// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import { IDRIFTCore } from "../interfaces/IDRIFTCore.sol";
import { IAttestationProvider } from "../interfaces/IAttestationProvider.sol";
import { DRIFTCoreStorage } from "./DRIFTCoreStorage.sol";
import { DRIFTTypes } from "../Common.sol";

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
    // Constants ===============================================================

    /// @notice Granted to addresses allowed to register contexts.
    ///         Granted to DRIFTClient contracts by the admin post-deploy.
    bytes32 public constant CLIENT_ROLE = keccak256("CLIENT_ROLE");

    /// @notice How long a node must wait between requesting and executing
    ///         deregistration. Prevents stake-then-slash-then-exit attacks.
    uint256 public constant UNBONDING_PERIOD = 7 days;

    // Constructor =============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializer — replaces constructor for upgradeable contracts.
    /// @param  admin  Receives DEFAULT_ADMIN_ROLE. Can upgrade and grant roles.
    function initialize(address admin) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // Context management ======================================================

    /// @inheritdoc IDRIFTCore
    function registerContext(
        string calldata name,
        address stakeToken,
        uint256 minimumStake
    ) external onlyRole(CLIENT_ROLE) returns (bytes32 uid) {
        require(bytes(name).length > 0, "DRIFT: empty context name");

        uid = keccak256(abi.encodePacked(name));

        require(!_usedNames[uid], "DRIFT: name already taken");

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
    function deactivateContext(bytes32 contextUID) external onlyContextOwner(contextUID) {
        _contexts[contextUID].active = false;
        emit ContextDeactivated(contextUID);
    }

    /// @inheritdoc IDRIFTCore
    function contextAdminRole(bytes32 contextUID) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("CONTEXT_ADMIN", contextUID));
    }

    // Schema management =======================================================

    /// @inheritdoc IDRIFTCore
    function addSchema(bytes32 contextUID, bytes32 schemaUID, address adapter) external onlyContextOwner(contextUID) {
        require(adapter != address(0), "DRIFT: zero adapter address");
        require(schemaUID != bytes32(0), "DRIFT: zero schema UID");

        _acceptedSchemas[contextUID][schemaUID] = true;
        _schemaAdapters[contextUID][schemaUID] = adapter;

        emit SchemaAdded(contextUID, schemaUID, adapter);
    }

    /// @inheritdoc IDRIFTCore
    function removeSchema(bytes32 contextUID, bytes32 schemaUID) external onlyContextOwner(contextUID) {
        require(_acceptedSchemas[contextUID][schemaUID], "DRIFT: schema not found");

        delete _acceptedSchemas[contextUID][schemaUID];
        delete _schemaAdapters[contextUID][schemaUID];

        emit SchemaRemoved(contextUID, schemaUID);
    }

    // Node registration =======================================================

    /// @inheritdoc IDRIFTCore
    function registerNode(bytes32 contextUID) external payable {
        DRIFTTypes.Context memory ctx = _contexts[contextUID];
        require(ctx.active, "DRIFT: context inactive");
        require(_stakes[contextUID][msg.sender] == 0, "DRIFT: already registered");
        require(_unlockTimes[contextUID][msg.sender] == 0, "DRIFT: deregistration pending");

        uint256 staked;

        if (ctx.minimumStake > 0) {
            if (ctx.stakeToken == address(0)) {
                // Native ETH
                require(msg.value >= ctx.minimumStake, "DRIFT: insufficient ETH stake");
                staked = msg.value;
            } else {
                // ERC-20 — caller must have approved DRIFTCore first
                require(msg.value == 0, "DRIFT: ETH not accepted for token stake");
                IERC20(ctx.stakeToken).transferFrom(msg.sender, address(this), ctx.minimumStake);
                staked = ctx.minimumStake;
            }
        } else {
            require(msg.value == 0, "DRIFT: no stake required");
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
        require(_stakes[contextUID][msg.sender] > 0, "DRIFT: not registered");
        require(_unlockTimes[contextUID][msg.sender] == 0, "DRIFT: already requested");

        uint256 unlockAt = block.timestamp + UNBONDING_PERIOD;
        _unlockTimes[contextUID][msg.sender] = unlockAt;

        emit DeregisterRequested(contextUID, msg.sender, unlockAt);
    }

    /// @inheritdoc IDRIFTCore
    function executeDeregister(bytes32 contextUID) external nonReentrant {
        uint256 unlockAt = _unlockTimes[contextUID][msg.sender];
        require(unlockAt != 0, "DRIFT: no deregister request");
        require(block.timestamp >= unlockAt, "DRIFT: unbonding period active");

        uint256 staked = _stakes[contextUID][msg.sender];
        DRIFTTypes.Context memory ctx = _contexts[contextUID];

        // Clear state before transfer — prevents reentrancy
        delete _stakes[contextUID][msg.sender];
        delete _unlockTimes[contextUID][msg.sender];

        // Return stake if one was actually held (not the sentinel value 1)
        if (staked > 1) {
            if (ctx.stakeToken == address(0)) {
                (bool ok, ) = msg.sender.call{ value: staked }("");
                require(ok, "DRIFT: ETH transfer failed");
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

    // Views ===================================================================

    /// @inheritdoc IDRIFTCore
    function getContext(bytes32 uid) external view returns (DRIFTTypes.Context memory) {
        require(_contextExists(uid), "DRIFT: context not found");
        return _contexts[uid];
    }

    /// @inheritdoc IDRIFTCore
    function getAdapter(bytes32 contextUID, bytes32 schemaUID) external view returns (address memory) {
        return _schemaAdapters[contextUID][schemaUID];
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

    modifier onlyContextOwner(bytes32 contextUID) {
        require(_contextExists(contextUID), "DRIFT: context not found");
        require(hasRole(contextAdminRole(contextUID), msg.sender), "DRIFT: not context admin");
        _;
    }

    // UUPS ====================================================================

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
