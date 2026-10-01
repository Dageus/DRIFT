//! ABI types shared with Solidity and with the TypeScript client. Field order is part of the
//! protocol: the input digest and the journal are ABI encodings of these structs.
#![allow(non_snake_case)]

use alloy_sol_types::sol;

sol! {
    #[derive(Debug, PartialEq, Eq)]
    struct Record {
        bytes32 uid;
        address attester;
        address subject;
        uint64 timestamp;
        bool revoked;
        bytes data;
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Member {
        address node;
        bytes32 role;
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Weight {
        address node;
        uint256 weight;
    }

    #[derive(Debug, PartialEq, Eq)]
    struct EngineInput {
        bytes32 engineId;
        bytes32 contextUID;
        uint256 epoch;
        uint64 tE;
        bytes32 schemaUID;
        string schemaDefinition;
        uint32 alphaPpm;
        uint32 epsilonPpm;
        uint32 iterations;
        uint256 defaultWeight;
        Record[] records;
        Member[] members;
        Weight[] pretrust;
    }

    /// What the engine commits to: a settler may post `merkleRoot` for (contextUID, epoch) only
    /// with evidence over this journal. `inputDigest` lets anyone holding the attestation set
    /// check which input produced the root.
    #[derive(Debug, PartialEq, Eq)]
    struct EngineJournal {
        bytes32 engineId;
        bytes32 contextUID;
        uint256 epoch;
        uint64 tE;
        bytes32 inputDigest;
        bytes32 merkleRoot;
    }
}
