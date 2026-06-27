// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTClientFactory } from "../../src/client/DRIFTClientFactory.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "forge-std/Test.sol";

contract DRIFTMerkleGasTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public client;

    address public admin = makeAddr("admin");
    uint256 public settlerPk = 0x1234;
    address public settler = vm.addr(settlerPk);
    address public node = makeAddr("node");

    bytes32 public contextUID;
    bytes32 constant ROLE = keccak256("ROLE");

    // SETUP ===================================================================

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

        factory = new DRIFTClientFactory(address(core));
        WeightedGovernanceClient template = new WeightedGovernanceClient();

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), address(factory));
        contextUID = core.registerContext("merkle.gas.test");

        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;

        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            settler,
            0,
            "EigenTrust",
            roles,
            weights
        );

        address cloneAddr =
            factory.deployClient(contextUID, address(template), initData, bytes32("salt"));
        client = WeightedGovernanceClient(cloneAddr);
        core.grantRole(core.contextAdminRole(contextUID), address(client));
        vm.stopPrank();

        vm.prank(node);
        core.registerNode(contextUID, "0x");
    }

    // BENCHMARKS ==============================================================

    /// @notice Benchmarks a reputation claim requiring a proof depth of 1 (2 users)
    function test_Gas_New_Claim_Depth1_2Users() public {
        _simulateAndMeasureClaim(1, 1, "Claim_Depth_1_Users_2");
    }

    /// @notice Benchmarks a reputation claim requiring a proof depth of 10 (1,024 users)
    function test_Gas_New_Claim_Depth10_1024Users() public {
        _simulateAndMeasureClaim(10, 1, "Claim_Depth_10_Users_1024");
    }

    /// @notice Benchmarks a reputation claim requiring a proof depth of 15 (32,768 users)
    function test_Gas_New_Claim_Depth15_32kUsers() public {
        _simulateAndMeasureClaim(15, 1, "Claim_Depth_15_Users_32768");
    }

    /// @notice Benchmarks a reputation claim requiring a proof depth of 20 (1,000,000+ users)
    function test_Gas_New_Claim_Depth20_1MUsers() public {
        _simulateAndMeasureClaim(20, 1, "Claim_Depth_20_Users_1M");
    }

    /// @notice Benchmarks the O(1) fixed cost of posting the epoch root
    function test_Gas_New_PostRoot_O1() public {
        bytes32 root = keccak256("dummy_root");
        bytes32 structHash =
            keccak256(abi.encode(client.SETTLE_ROOT_TYPEHASH(), contextUID, 1, root));
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("DRIFT_WeightedGovernance")),
                keccak256(bytes("1")),
                block.chainid,
                address(client)
            )
        );

        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerPk, digest);

        vm.startSnapshotGas("PostRoot_O1_Cost");
        client.postEpochRoot(1, root, "", abi.encodePacked(r, s, v));
        vm.stopSnapshotGas();
    }

    // INTERNAL HELPERS ========================================================

    /// @dev Helper to construct a synthetic Merkle proof, settle the root, and execute the gas snapshot
    function _simulateAndMeasureClaim(
        uint256 depth,
        uint256 epoch,
        string memory snapshotName
    ) internal {
        uint256 score = 100;
        bytes32 calculatedRoot;
        bytes32[] memory proof = new bytes32[](depth);

        {
            bytes32 currentHash = keccak256(
                bytes.concat(keccak256(abi.encode(contextUID, node, ROLE, score, epoch)))
            );
            for (uint256 i = 0; i < depth; i++) {
                bytes32 sibling = keccak256(abi.encode("dummy_sibling", epoch, i));
                proof[i] = sibling;

                // OpenZeppelin sorts pairs before hashing
                if (currentHash < sibling) {
                    currentHash = keccak256(abi.encodePacked(currentHash, sibling));
                } else {
                    currentHash = keccak256(abi.encodePacked(sibling, currentHash));
                }
            }
            calculatedRoot = currentHash;
        }

        {
            bytes32 domainSeparator = keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("DRIFT_WeightedGovernance")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(client)
                )
            );
            bytes32 structHash = keccak256(
                abi.encode(client.SETTLE_ROOT_TYPEHASH(), contextUID, epoch, calculatedRoot)
            );
            bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);

            (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerPk, digest);
            client.postEpochRoot(epoch, calculatedRoot, "", abi.encodePacked(r, s, v));
        }

        vm.startSnapshotGas(snapshotName);
        vm.prank(node);
        client.claimReputation(node, ROLE, score, epoch, proof);
        vm.stopSnapshotGas();
    }
}
