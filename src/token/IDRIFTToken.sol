// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IDRIFTToken {
    /// @notice Mints reputation to a user for a specific context.
    function rewardReputation(address to, uint256 tokenId, uint256 amount) external;

    /// @notice Burns reputation from a user for a specific context.
    function slashReputation(address from, uint256 tokenId, uint256 amount) external;
}
