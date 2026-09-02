// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTCore } from "../../../src/core/DRIFTCore.sol";
import { IEAS } from "../../../src/interfaces/IEAS.sol";
import { EASPolicy } from "../../../src/policies/EASPolicy.sol";
import { NodeStatus } from "../../../src/policies/IPolicy.sol";
import { DRIFTToken } from "../../../src/token/DRIFTToken.sol";
import { MockEAS } from "../../mocks/MockEAS.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "forge-std/Test.sol";

contract EASPolicyTest is Test {
    DRIFTCore public core;
    DRIFTToken public driftToken;
    MockEAS public mockEAS;
    EASPolicy public policy;

    address public admin = makeAddr("admin");
    address public applicant = makeAddr("applicant");
    address public trustedIssuer = makeAddr("trustedIssuer");
    bytes32 public contextUID;

    bytes32 constant REQUIRED_SCHEMA = keccak256("test.schema.v1");

    function setUp() public {
        DRIFTCore implementation = new DRIFTCore();
        bytes memory initData = abi.encodeWithSelector(DRIFTCore.initialize.selector, admin);
        core = DRIFTCore(address(new ERC1967Proxy(address(implementation), initData)));
        driftToken = new DRIFTToken(address(core));

        vm.prank(admin);
        core.setDriftToken(address(driftToken));

        vm.prank(admin);
        contextUID = core.registerContext("eas-policy.test");

        mockEAS = new MockEAS();
        policy = new EASPolicy(address(mockEAS), REQUIRED_SCHEMA, trustedIssuer);

        vm.prank(admin);
        core.setContextPolicy(contextUID, address(policy));
    }

    // HELPERS =================================================================

    function _validAttestation(
        bytes32 uid
    ) internal view returns (IEAS.Attestation memory) {
        return IEAS.Attestation({
            uid: uid,
            schema: REQUIRED_SCHEMA,
            time: uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID: bytes32(0),
            recipient: applicant,
            attester: trustedIssuer,
            revocable: true,
            data: ""
        });
    }

    // EVALUATE =================================================================

    function test_EvaluateReturnsFullForValidAttestation() public {
        bytes32 uid = keccak256("attestation.1");
        mockEAS.mockAttestation(uid, _validAttestation(uid));

        vm.prank(applicant);
        core.registerNode(contextUID, abi.encode(uid));

        assertEq(uint256(core.nodeStatus(contextUID, applicant)), uint256(NodeStatus.FULL));
    }

    function test_RevertIf_AttestationNotFound() public {
        // Never mocked — MockEAS returns a zero-valued struct whose uid is bytes32(0), which can
        // never equal the non-zero UID actually being looked up.
        bytes32 uid = keccak256("attestation.never-made");

        vm.prank(applicant);
        vm.expectRevert(EASPolicy.AttestationNotFound.selector);
        core.registerNode(contextUID, abi.encode(uid));
    }

    function test_RevertIf_WrongSchema() public {
        bytes32 uid = keccak256("attestation.wrongschema");
        IEAS.Attestation memory att = _validAttestation(uid);
        att.schema = keccak256("some.other.schema");
        mockEAS.mockAttestation(uid, att);

        vm.prank(applicant);
        vm.expectRevert(EASPolicy.InvalidSchema.selector);
        core.registerNode(contextUID, abi.encode(uid));
    }

    function test_RevertIf_WrongIssuer() public {
        bytes32 uid = keccak256("attestation.wrongissuer");
        IEAS.Attestation memory att = _validAttestation(uid);
        att.attester = makeAddr("untrustedIssuer");
        mockEAS.mockAttestation(uid, att);

        vm.prank(applicant);
        vm.expectRevert(EASPolicy.InvalidIssuer.selector);
        core.registerNode(contextUID, abi.encode(uid));
    }

    function test_RevertIf_WrongRecipient() public {
        // A genuine attestation from the trusted issuer, under the right schema, but issued
        // about someone else entirely — must not let `applicant` piggyback on it.
        bytes32 uid = keccak256("attestation.wrongrecipient");
        IEAS.Attestation memory att = _validAttestation(uid);
        att.recipient = makeAddr("someoneElse");
        mockEAS.mockAttestation(uid, att);

        vm.prank(applicant);
        vm.expectRevert(EASPolicy.InvalidRecipient.selector);
        core.registerNode(contextUID, abi.encode(uid));
    }

    function test_RevertIf_AttestationRevoked() public {
        bytes32 uid = keccak256("attestation.revoked");
        IEAS.Attestation memory att = _validAttestation(uid);
        att.revocationTime = uint64(block.timestamp);
        mockEAS.mockAttestation(uid, att);

        vm.prank(applicant);
        vm.expectRevert(EASPolicy.AttestationRevoked.selector);
        core.registerNode(contextUID, abi.encode(uid));
    }

    // CONSTRUCTOR ==============================================================

    function test_ConstructorSetsImmutables() public view {
        assertEq(address(policy.eas()), address(mockEAS));
        assertEq(policy.requiredSchema(), REQUIRED_SCHEMA);
        assertEq(policy.trustedIssuer(), trustedIssuer);
    }
}
