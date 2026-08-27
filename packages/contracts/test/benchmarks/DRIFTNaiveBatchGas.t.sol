// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { NaiveBatchSettler } from "../mocks/NaiveBatchSettler.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "forge-std/Test.sol";

/// @title DRIFTNaiveBatchGasTest
/// @notice Reconstructs the naive per-node on-chain settlement comparison referenced in
///         CLAUDE.md's "Useful background" section (O(N), block-gas-limit failure at ~404
///         nodes) and in Phase 3 item 4 of the Evaluation chapter's measurement plan. The
///         original benchmark's source was never committed to this repo — only its
///         `snapshots/DRIFTBatchGasTest.json` output survives (5-500 in loose steps, plus
///         700-3000). This file reproduces that shape and adds dense sampling in the 250-500
///         range specifically to fit the failure-boundary regression (slope, R^2) Phase 3 asks
///         for, rather than eyeballing a single "~404" estimate from 5 sparse points.
/// @dev    NaiveBatchSettler is test-only (see test/mocks/NaiveBatchSettler.sol) — no such
///         unbounded per-node settlement path exists in the shipped protocol.
contract DRIFTNaiveBatchGasTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    NaiveBatchSettler public naiveSettler;

    address public admin = makeAddr("admin");
    bytes32 public contextUID;
    bytes32 constant ROLE = keccak256("ROLE");

    function setUp() public {
        DRIFTCore coreImpl = new DRIFTCore();
        core = DRIFTCore(
            address(
                new ERC1967Proxy(
                    address(coreImpl), abi.encodeWithSelector(DRIFTCore.initialize.selector, admin)
                )
            )
        );

        driftToken = new DRIFTToken(address(core));
        vm.prank(admin);
        core.setDriftToken(address(driftToken));

        naiveSettler = new NaiveBatchSettler(address(core));

        vm.startPrank(admin);
        contextUID = core.registerContext("naive.batch.gas.test");
        // NaiveBatchSettler stands in for a context client here purely to satisfy
        // `onlyContextClient` on core.reward — it is not a real governance client.
        core.grantRole(core.FACTORY_ROLE(), admin);
        core.setContextClient(contextUID, address(naiveSettler), admin);
        vm.stopPrank();
    }

    // WIDE RANGE (anchors the O(N) fit, matches the historical dataset's shape) ===============

    function test_Gas_NaiveBatch_N10() public {
        _registerAndSettle(10, "BatchSize_10");
    }

    function test_Gas_NaiveBatch_N50() public {
        _registerAndSettle(50, "BatchSize_50");
    }

    function test_Gas_NaiveBatch_N100() public {
        _registerAndSettle(100, "BatchSize_100");
    }

    function test_Gas_NaiveBatch_N200() public {
        _registerAndSettle(200, "BatchSize_200");
    }

    // DENSE SAMPLING NEAR THE ~404-NODE FAILURE BOUNDARY (Phase 3 item 4) =====================

    function test_Gas_NaiveBatch_N250() public {
        _registerAndSettle(250, "BatchSize_250");
    }

    function test_Gas_NaiveBatch_N300() public {
        _registerAndSettle(300, "BatchSize_300");
    }

    function test_Gas_NaiveBatch_N325() public {
        _registerAndSettle(325, "BatchSize_325");
    }

    function test_Gas_NaiveBatch_N350() public {
        _registerAndSettle(350, "BatchSize_350");
    }

    function test_Gas_NaiveBatch_N375() public {
        _registerAndSettle(375, "BatchSize_375");
    }

    function test_Gas_NaiveBatch_N390() public {
        _registerAndSettle(390, "BatchSize_390");
    }

    function test_Gas_NaiveBatch_N400() public {
        _registerAndSettle(400, "BatchSize_400");
    }

    function test_Gas_NaiveBatch_N404() public {
        _registerAndSettle(404, "BatchSize_404");
    }

    function test_Gas_NaiveBatch_N410() public {
        _registerAndSettle(410, "BatchSize_410");
    }

    function test_Gas_NaiveBatch_N425() public {
        _registerAndSettle(425, "BatchSize_425");
    }

    function test_Gas_NaiveBatch_N450() public {
        _registerAndSettle(450, "BatchSize_450");
    }

    function test_Gas_NaiveBatch_N475() public {
        _registerAndSettle(475, "BatchSize_475");
    }

    function test_Gas_NaiveBatch_N500() public {
        _registerAndSettle(500, "BatchSize_500");
    }

    // WIDE RANGE, ABOVE THE BOUNDARY (confirms the fit holds well past failure) ================

    function test_Gas_NaiveBatch_N700() public {
        _registerAndSettle(700, "BatchSize_700");
    }

    function test_Gas_NaiveBatch_N900() public {
        _registerAndSettle(900, "BatchSize_900");
    }

    function test_Gas_NaiveBatch_N950() public {
        _registerAndSettle(950, "BatchSize_950");
    }

    function test_Gas_NaiveBatch_N1000() public {
        _registerAndSettle(1000, "BatchSize_1000");
    }

    function test_Gas_NaiveBatch_N1050() public {
        _registerAndSettle(1050, "BatchSize_1050");
    }

    // INTERNAL HELPERS ==========================================================

    function _registerAndSettle(
        uint256 n,
        string memory snapshotName
    ) internal {
        address[] memory nodes = new address[](n);
        uint256[] memory scores = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            address node = address(uint160(0x10000 + i));
            vm.prank(node);
            core.registerNode(contextUID, "0x");
            nodes[i] = node;
            scores[i] = 100;
        }

        vm.startSnapshotGas(snapshotName);
        naiveSettler.settleBatch(contextUID, ROLE, nodes, scores);
        vm.stopSnapshotGas();
    }
}
