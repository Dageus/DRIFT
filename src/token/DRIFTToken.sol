// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IDRIFTToken } from "./IDRIFTToken.sol";

/// @title  DRIFTToken
/// @notice Non-transferable (Soulbound) ERC-1155 multi-token for reputation.
/// @dev    Controlled exclusively by the DRIFTCore registry.
contract DRIFTToken is ERC1155, Ownable, IDRIFTToken {
    /// @param coreRegistry The address of the DRIFTCore contract.
    constructor(
        address coreRegistry
    )
        ERC1155("") // URI is empty for MVP; rely on tokenNames mapping instead
        Ownable(coreRegistry)
    {}

    // Soulbound Enforcement ===================================================

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes memory data
    ) public virtual override(ERC1155, IERC1155) {
        revert("Non-transmissible token: Transfers are disabled.");
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) public virtual override(ERC1155, IERC1155) {
        revert("Non-transmissible token: Transfers are disabled.");
    }

    // Reputation Management ===================================================

    /// @inheritdoc IDRIFTToken
    function rewardReputation(address to, uint256 tokenId, uint256 amount) external onlyOwner {
        _mint(to, tokenId, amount, "");
    }

    /// @inheritdoc IDRIFTToken
    function slashReputation(address from, uint256 tokenId, uint256 amount) external onlyOwner {
        _burn(from, tokenId, amount);
    }
}
