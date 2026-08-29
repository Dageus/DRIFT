// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { EASAdapter, IEAS } from "../../../src/providers/EAS.sol";
import { MockEAS } from "../../mocks/MockEAS.sol";
import "forge-std/Test.sol";

contract EASAdapterTest is Test {
    MockEAS public mockEAS;
    EASAdapter public adapter;

    function setUp() public {
        mockEAS = new MockEAS();

        adapter = new EASAdapter(address(mockEAS));
    }

    function test_AdapterReturnsTrueForValidAttestation() public {
        bytes32 uid = bytes32("attest1");
        bytes32 schema = bytes32("schema1");
        address subject = makeAddr("alice");

        IEAS.Attestation memory validAttestation = IEAS.Attestation({
            uid: uid,
            schema: schema,
            time: uint64(block.timestamp),
            expirationTime: 0, // Doesn't expire
            revocationTime: 0, // Not revoked
            refUID: bytes32(0),
            recipient: subject,
            attester: makeAddr("bob"),
            revocable: true,
            data: ""
        });
        mockEAS.mockAttestation(uid, validAttestation);

        assertTrue(adapter.isValid(uid, schema, subject, 0, 0));
    }

    function test_AdapterReturnsFalseIfRevoked() public {
        bytes32 uid = bytes32("attest2");
        bytes32 schema = bytes32("schema1");
        address subject = makeAddr("alice");

        IEAS.Attestation memory revokedAttestation = IEAS.Attestation({
            uid: uid,
            schema: schema,
            time: uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: uint64(block.timestamp),
            refUID: bytes32(0),
            recipient: subject,
            attester: makeAddr("bob"),
            revocable: true,
            data: ""
        });
        mockEAS.mockAttestation(uid, revokedAttestation);

        assertFalse(adapter.isValid(uid, schema, subject, 0, 0));
    }

    function test_AdapterReturnsFalseIfExpired() public {
        vm.warp(30 days);

        bytes32 uid = bytes32("attest3");
        bytes32 schema = bytes32("schema1");
        address subject = makeAddr("alice");

        IEAS.Attestation memory expiredAttestation = IEAS.Attestation({
            uid: uid,
            schema: schema,
            time: uint64(block.timestamp - 10 days),
            expirationTime: uint64(block.timestamp - 1 days),
            revocationTime: 0,
            refUID: bytes32(0),
            recipient: subject,
            attester: makeAddr("bob"),
            revocable: true,
            data: ""
        });
        mockEAS.mockAttestation(uid, expiredAttestation);

        assertFalse(adapter.isValid(uid, schema, subject, 0, 0));
    }

    function test_AdapterReturnsFalseIfPredatesSubjectJoin() public {
        bytes32 uid = bytes32("attest4");
        bytes32 schema = bytes32("schema1");
        address subject = makeAddr("alice");

        IEAS.Attestation memory a = IEAS.Attestation({
            uid: uid,
            schema: schema,
            time: uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID: bytes32(0),
            recipient: subject,
            attester: makeAddr("bob"),
            revocable: true,
            data: ""
        });
        mockEAS.mockAttestation(uid, a);

        // Regression test: a node that left and rejoined must not retain reputation history from
        // before its most recent join — subjectJoinedAt strictly after the attestation's own
        // timestamp must reject it.
        assertFalse(adapter.isValid(uid, schema, subject, block.timestamp + 1, 0));
    }

    function test_AdapterReturnsFalseIfPredatesAttesterJoin() public {
        bytes32 uid = bytes32("attest5");
        bytes32 schema = bytes32("schema1");
        address subject = makeAddr("alice");

        IEAS.Attestation memory a = IEAS.Attestation({
            uid: uid,
            schema: schema,
            time: uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID: bytes32(0),
            recipient: subject,
            attester: makeAddr("bob"),
            revocable: true,
            data: ""
        });
        mockEAS.mockAttestation(uid, a);

        assertFalse(adapter.isValid(uid, schema, subject, 0, block.timestamp + 1));
    }
}
