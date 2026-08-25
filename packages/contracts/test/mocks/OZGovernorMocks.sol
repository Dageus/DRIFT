// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Governor } from "@openzeppelin/contracts/governance/Governor.sol";
import {
    GovernorCountingSimple
} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import { GovernorVotes } from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {
    GovernorVotesQuorumFraction
} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import { IVotes } from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { ERC20Votes } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import { Nonces } from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title BaselineVotesToken
/// @notice Minimal ERC20Votes token for the OZ Governor gas baseline (Phase 3 item 2). Standing
///         in for DRIFT's role-weighted ERC-1155 balances — a plain ERC20Votes token is what a
///         "vanilla" DAO stack actually uses, so it's the fair comparison point.
contract BaselineVotesToken is ERC20, ERC20Permit, ERC20Votes {
    constructor() ERC20("Baseline", "BASE") ERC20Permit("Baseline") { }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(
        address owner
    ) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}

/// @title BaselineGovernor
/// @notice Minimal vanilla OZ Governor (no timelock) — the "standard DAO implementation" the
///         dissertation's text asserts DRIFT's vote cost approximates, without previously showing
///         the comparison number (Phase 3 item 2). votingDelay/votingPeriod are set short purely
///         so the gas-benchmark test doesn't need to roll thousands of blocks; they don't affect
///         the per-vote gas cost being measured.
contract BaselineGovernor is
    Governor,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction
{
    constructor(
        IVotes _token
    ) Governor("BaselineGovernor") GovernorVotes(_token) GovernorVotesQuorumFraction(4) { }

    function votingDelay() public pure override returns (uint256) {
        return 1;
    }

    function votingPeriod() public pure override returns (uint256) {
        return 50;
    }

    function proposalThreshold() public pure override returns (uint256) {
        return 0;
    }
}
