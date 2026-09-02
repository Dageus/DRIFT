// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { EASAdapter } from "../../src/providers/EAS.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "forge-std/Test.sol";

/// @dev Minimal write-side interfaces for the real EAS/SchemaRegistry contracts. Deliberately not
/// added to src/interfaces/IEAS.sol: production code only ever reads attestations
/// (IEAS.getAttestation, see EASAdapter.sol) — it never attests or registers schemas itself, so
/// those functions have no business being in the production interface. This file drives the real
/// contracts as an external actor would, exactly the way an attester/game backend does.
interface IEASWrite {
    struct AttestationRequestData {
        address recipient;
        uint64 expirationTime;
        bool revocable;
        bytes32 refUID;
        bytes data;
        uint256 value;
    }

    struct AttestationRequest {
        bytes32 schema;
        AttestationRequestData data;
    }

    struct RevocationRequestData {
        bytes32 uid;
        uint256 value;
    }

    struct RevocationRequest {
        bytes32 schema;
        RevocationRequestData data;
    }

    function attest(
        AttestationRequest calldata request
    ) external payable returns (bytes32);

    function revoke(
        RevocationRequest calldata request
    ) external payable;
}

interface ISchemaRegistryWrite {
    function register(
        string calldata schema,
        address resolver,
        bool revocable
    ) external returns (bytes32);
}

/// @title EASIntegrationForkTest
/// @notice Exercises DRIFTCore/EASAdapter against the REAL EAS + SchemaRegistry contracts deployed
///         on Sepolia, forked locally — not a MockEAS stand-in. Catches real ABI/behavior drift
///         (struct layout, revocation semantics, schema registration) that a mock, by construction,
///         cannot: a mock only ever proves DRIFT correctly implements DRIFT's own assumptions about
///         EAS, not that those assumptions are correct.
///
/// @dev Opt-in only. `forge test`'s default run must stay network-independent (fast, deterministic,
///      runs in sandboxed/offline environments) — this file gates every test on FORK_TESTS=true via
///      vm.skip, so the default run reports these as skipped rather than attempting a fork at all.
///      Run explicitly with: FORK_TESTS=true forge test --match-path 'test/fork/*' -vvv
///
///      Uses vm.createSelectFork, not --fork-url, so the RPC endpoint is read from foundry.toml's
///      [rpc_endpoints] "sepolia" entry — the same one packages/contracts already configures for
///      deployment scripts. No broadcast, no funded wallet, no real transactions: fork execution is
///      local against a pinned remote state snapshot.
contract EASIntegrationForkTest is Test {
    // Real EAS deployment addresses on Sepolia (chain id 11155111), from
    // https://github.com/ethereum-attestation-service/eas-contracts/blob/master/deployments/sepolia/{EAS,SchemaRegistry}.json
    // — verified live against the RPC in packages/contracts/foundry.toml's [rpc_endpoints].sepolia
    // before writing this test (getSchemaRegistry() on EAS_ADDRESS returns SCHEMA_REGISTRY_ADDRESS
    // exactly).
    address internal constant EAS_ADDRESS = 0xC2679fBD37d54388Ce493F1DB75320D236e1815e;
    address internal constant SCHEMA_REGISTRY_ADDRESS = 0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0;

    DRIFTCore internal core;
    EASAdapter internal adapter;
    IEASWrite internal eas;
    ISchemaRegistryWrite internal schemaRegistry;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal attester = makeAddr("attester");
    address internal subject = makeAddr("subject");

    bytes32 internal contextUID;
    bytes32 internal schemaUID;

    function setUp() public {
        if (!vm.envOr("FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }

        vm.createSelectFork("sepolia");

        eas = IEASWrite(EAS_ADDRESS);
        schemaRegistry = ISchemaRegistryWrite(SCHEMA_REGISTRY_ADDRESS);

        DRIFTCore implementation = new DRIFTCore();
        bytes memory initData = abi.encodeWithSelector(DRIFTCore.initialize.selector, admin);
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        core = DRIFTCore(address(proxy));

        adapter = new EASAdapter(EAS_ADDRESS);

        vm.prank(creator);
        contextUID = core.registerContext("fork-test.context");

        vm.prank(attester);
        core.registerNode(contextUID, "0x");
        vm.prank(subject);
        core.registerNode(contextUID, "0x");

        // Register a fresh schema on the REAL SchemaRegistry — no resolver, revocable — then
        // accept it into the context via the REAL adapter, exactly as a deployment script would.
        schemaUID = schemaRegistry.register("uint256 score", address(0), true);

        vm.prank(creator);
        core.addSchema(contextUID, schemaUID, address(adapter));
    }

    /// @notice A real EAS attestation, made by a registered attester about a registered subject,
    ///         is accepted by DRIFTCore.verifyAttestation end to end (EASAdapter -> real
    ///         EAS.getAttestation, not a mock).
    function testFork_RealAttestationVerifiesTrue() public {
        vm.deal(attester, 1 ether);

        vm.prank(attester);
        bytes32 uid = eas.attest(
            IEASWrite.AttestationRequest({
                schema: schemaUID,
                data: IEASWrite.AttestationRequestData({
                    recipient: subject,
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode(uint256(100)),
                    value: 0
                })
            })
        );

        assertTrue(core.verifyAttestation(contextUID, schemaUID, uid, subject, attester));
    }

    /// @notice A revoked real attestation is rejected — proves EASAdapter reads the real
    ///         revocationTime field correctly, not just a mock's version of it.
    function testFork_RevokedRealAttestationVerifiesFalse() public {
        vm.deal(attester, 1 ether);

        vm.startPrank(attester);
        bytes32 uid = eas.attest(
            IEASWrite.AttestationRequest({
                schema: schemaUID,
                data: IEASWrite.AttestationRequestData({
                    recipient: subject,
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode(uint256(100)),
                    value: 0
                })
            })
        );

        assertTrue(core.verifyAttestation(contextUID, schemaUID, uid, subject, attester));

        eas.revoke(
            IEASWrite.RevocationRequest({
                schema: schemaUID, data: IEASWrite.RevocationRequestData({ uid: uid, value: 0 })
            })
        );
        vm.stopPrank();

        assertFalse(core.verifyAttestation(contextUID, schemaUID, uid, subject, attester));
    }

    /// @notice An attestation for a schema DRIFT never accepted into the context is rejected
    ///         before EASAdapter is even consulted — proves the real, on-registry schemaUID
    ///         DRIFT never approved doesn't accidentally verify.
    function testFork_UnacceptedSchemaVerifiesFalse() public {
        bytes32 otherSchemaUID = schemaRegistry.register("uint256 otherScore", address(0), true);

        vm.deal(attester, 1 ether);
        vm.prank(attester);
        bytes32 uid = eas.attest(
            IEASWrite.AttestationRequest({
                schema: otherSchemaUID,
                data: IEASWrite.AttestationRequestData({
                    recipient: subject,
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode(uint256(100)),
                    value: 0
                })
            })
        );

        assertFalse(core.verifyAttestation(contextUID, otherSchemaUID, uid, subject, attester));
    }
}
