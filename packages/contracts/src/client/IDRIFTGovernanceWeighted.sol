// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTGovernance } from "./IDRIFTGovernance.sol";

/// @title IDRIFTGovernanceTokenWeighted
/// @notice Extension for clients that use live ERC-1155 balances for queries.
/// @dev WARNING: Live balances are vulnerable to flash manipulation.
//       This interface is for UI display and non-critical queries only.
interface IDRIFTGovernanceTokenWeighted is IDRIFTGovernance {
    // VIEWS ===================================================================

    /// @notice Returns the current live voting power of an address
    /// @param account The address to query
    /// @return The calculated voting power based on live balances
    function getVotingPower(
        address account
    ) external view returns (uint256);

    /// @notice Returns the active roles recognized in this context
    /// @return Array of active role identifiers
    function getActiveRoles() external view returns (bytes32[] memory);
}
