// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title  DRIFTToken
/// @notice Native utility token for the DRIFT ecosystem.
/// @dev    Implements ERC20Permit for single-transaction staking flows.
contract DRIFTToken is ERC20, ERC20Permit {
    /// @notice Maximum supply of 100 million tokens.
    uint256 public constant MAX_SUPPLY = 100_000_000 * 10 ** 18;

    /// @notice Deploys the token and mints the supply to the protocol treasury.
    /// @param  treasury The address that receives the initial token supply.
    constructor(address treasury) ERC20("DRIFT Protocol", "DRIFT") ERC20Permit("DRIFT Protocol") {
        require(treasury != address(0), "DRIFT: zero treasury address");
        _mint(treasury, MAX_SUPPLY);
    }
}
