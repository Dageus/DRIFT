// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// @title IDRIFTToken
/// @notice Interface for the soulbound ERC-1155 reputation token.
interface IDRIFTToken is IERC1155 {
    /// @notice Error thrown when transfer functions are attempted on DRIFTToken.
    error NonTransmissibleToken();

    /// @notice Mints soulbound reputation to a specific context/role token ID.
    /// @param to The address receiving the reputation.
    /// @param tokenId The hashed contextUID and role.
    /// @param amount The amount of reputation to mint.
    function rewardReputation(
        address to,
        uint256 tokenId,
        uint256 amount
    ) external;

    /// @notice Burns soulbound reputation.
    /// @param from The address losing the reputation.
    /// @param tokenId The hashed contextUID and role.
    /// @param amount The amount to burn.
    function slashReputation(
        address from,
        uint256 tokenId,
        uint256 amount
    ) external;
}
