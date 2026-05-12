// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { IDRIFTCore } from "../core/IDRIFTCore.sol";

contract DRIFTClientFactory {
    IDRIFTCore public immutable core;

    mapping(bytes32 => address) public contextClient;

    event ClientDeployed(address indexed client, bytes32 indexed contextUID, address implementation);

    constructor(address _core) {
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
        require(core.hasRole(adminRole, msg.sender), "Not context admin");
        require(contextClient[contextUID] == address(0), "Client already exists");
        require(implementation != address(0), "Invalid implementation");

        clone = Clones.cloneDeterministic(implementation, keccak256(abi.encodePacked(contextUID, salt)));

        if (initData.length > 0) {
            (bool success, bytes memory returnData) = clone.call(initData);
            if (!success) {
                // Bubble up the exact revert reason from the implementation
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
        }

        contextClient[contextUID] = clone;
        emit ClientDeployed(clone, contextUID, implementation);
    }
}
