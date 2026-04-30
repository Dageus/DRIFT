// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title  DRIFTToken
/// @notice Non-transferable (Soulbound) reputation token.
/// @dev    Controlled exclusively by the DRIFTCore registry.
contract DRIFTToken is ERC20, Ownable {
    /// @param coreRegistry The address of the DRIFTCore contract.
    constructor(address coreRegistry) ERC20("DRIFT Reputation", "DRIFT") Ownable(coreRegistry) {}

    function transfer(address recipient, uint256 amount) public pure override returns (bool) {
        revert("Non-transmissible token: Transfers are disabled.");
    }

    function transferFrom(address sender, address recipient, uint256 amount) public pure override returns (bool) {
        revert("Non-transmissible token: Transfers are disabled.");
    }

    /// @notice Mints reputation to a user. Only callable by DRIFTCore.
    function rewardReputation(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Burns reputation from a user. Only callable by DRIFTCore.
    function slashReputation(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}
