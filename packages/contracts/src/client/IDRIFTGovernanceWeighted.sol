// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTGovernance } from "./IDRIFTGovernance.sol";

/// @title IDRIFTGovernanceTokenWeighted
/// @notice Extension for clients that use live ERC-1155 balances for queries.
/// @dev    WARNING: Live balances are vulnerable to flash manipulation.
///         This interface is for UI display and non-critical queries only.
interface IDRIFTGovernanceTokenWeighted is IDRIFTGovernance {
    /// @notice Returns the current voting power of an address.
    function getVotingPower(address account) external view returns (uint256);

    /// @notice Returns the active roles in this context.
    function getActiveRoles() external view returns (bytes32[] memory);
}
