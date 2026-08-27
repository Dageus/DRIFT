// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTCore } from "../core/IDRIFTCore.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

contract DRIFTClientFactory {
    IDRIFTCore public immutable core;

    // Errors ==================================================================

    /// @notice Error thrown when a user that is not context admin makes a call.
    error NotContextAdmin(address caller);
    /// @notice Error thrown when an empty implementation is provided.
    error InvalidImplementation();

    constructor(
        address _core
    ) {
        core = IDRIFTCore(_core);
    }

    /// @notice Deploys any EIP-1167 template and initializes it in one transaction.
    /// @param contextUID The context this client belongs to.
    /// @param implementation The address of the template logic contract.
    /// @param initData The ABI-encoded initialization function and arguments.
    /// @param salt Unique salt for deterministic address generation.
    function deployClient(
        bytes32 contextUID,
        address implementation,
        bytes calldata initData,
        bytes32 salt
    ) external returns (address clone) {
        bytes32 adminRole = core.contextAdminRole(contextUID);
        if (!core.hasRole(adminRole, msg.sender)) revert NotContextAdmin(msg.sender);
        if (implementation == address(0)) revert InvalidImplementation();

        clone = Clones.cloneDeterministic(
            implementation, keccak256(abi.encodePacked(contextUID, salt))
        );

        if (initData.length > 0) {
            (bool success, bytes memory returnData) = clone.call(initData);
            if (!success) {
                // Bubble up the exact revert reason from the implementation
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
        }

        core.setContextClient(contextUID, clone, msg.sender);
    }
}
