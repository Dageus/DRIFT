// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { BaselineGovernor, BaselineVotesToken } from "../mocks/OZGovernorMocks.sol";
import "forge-std/Test.sol";

/// @title DRIFTGovernorBaselineTest
/// @notice Phase 3 item 2: deploys vanilla OZ Governor + ERC20Votes in the same harness/commit as
///         DRIFT's own benchmarks and measures a comparable vote transaction, so the
///         dissertation's claim that DRIFT's vote cost "approximates standard DAO implementations"
///         has an actual number to point to instead of an assertion.
contract DRIFTGovernorBaselineTest is Test {
    BaselineVotesToken public token;
    BaselineGovernor public governor;

    address public voter = makeAddr("voter");
    address public proposer = makeAddr("proposer");

    function setUp() public {
        token = new BaselineVotesToken();
        governor = new BaselineGovernor(token);

        token.mint(voter, 1000 ether);
        token.mint(proposer, 1000 ether);

        vm.prank(voter);
        token.delegate(voter);
        vm.prank(proposer);
        token.delegate(proposer);

        // Voting power is read from a past block checkpoint (getPastVotes) — must mine past the
        // delegation before a proposal snapshot can see it.
        vm.roll(block.number + 1);
    }

    // BENCHMARKS ==============================================================

    /// @notice Cost of a plain no-op proposal — the OZ-side equivalent of
    ///         `createProposalWithProofs` (DRIFTVoteGas.t.sol).
    function test_Gas_OZGovernor_Propose() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) = _noopCall();

        vm.prank(proposer);
        vm.startSnapshotGas("OZGovernor_Propose");
        governor.propose(targets, values, calldatas, "Baseline proposal");
        vm.stopSnapshotGas();
    }

    /// @notice Cost of casting a vote on an already-open proposal — the direct comparison point
    ///         for DRIFT's Vote_Depth_* snapshots. Unlike DRIFT, this does NOT include Merkle
    ///         proof verification: OZ Governor reads voting power from an on-chain checkpoint
    ///         (`getPastVotes`), so this is the cost DRIFT's O(log N) proof check is buying
    ///         accountability against, not a like-for-like O(1) read.
    function test_Gas_OZGovernor_CastVote() public {
        uint256 proposalId = _propose();
        vm.roll(block.number + governor.votingDelay() + 1);

        vm.prank(voter);
        vm.startSnapshotGas("OZGovernor_CastVote");
        governor.castVote(proposalId, 1); // 1 = For
        vm.stopSnapshotGas();
    }

    /// @notice Cost of delegating voting power — the OZ-side prerequisite DRIFT has no equivalent
    ///         of (DRIFT reads role-weighted balances directly via Merkle proof, no delegation
    ///         step). Included so the full "cost to participate" comparison is honest, not just
    ///         the per-vote number.
    function test_Gas_OZGovernor_Delegate() public {
        address freshVoter = makeAddr("freshVoter");
        token.mint(freshVoter, 100 ether);

        vm.prank(freshVoter);
        vm.startSnapshotGas("OZGovernor_Delegate");
        token.delegate(freshVoter);
        vm.stopSnapshotGas();
    }

    // INTERNAL HELPERS ==========================================================

    function _noopCall()
        internal
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        targets = new address[](1);
        targets[0] = address(0x1);
        values = new uint256[](1);
        values[0] = 0;
        calldatas = new bytes[](1);
        calldatas[0] = "";
    }

    function _propose() internal returns (uint256) {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) = _noopCall();
        vm.prank(proposer);
        return governor.propose(targets, values, calldatas, "Baseline proposal");
    }
}
