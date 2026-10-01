//! Deterministic core of the DRIFT reputation function Phi_c.
//!
//! The same code runs in three places: the gRPC engine server (Tier 1 and Tier 2), the RISC Zero
//! guest (Tier 3), and the test-vector check against the TypeScript reference implementation in
//! `packages/sdk/src/engines/EigenTrust.ts`. Every rule that fixes the output bit for bit (input
//! order, integer arithmetic, rounding, record validity) is written down in `../SPEC.md`; change
//! the spec, the TypeScript reference and the vectors together or not at all.

pub mod eigentrust;
pub mod merkle;
pub mod types;

use std::collections::BTreeMap;

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::SolValue;

pub use types::{EngineInput, EngineJournal, Member, Record, Weight};

/// Name of the only engine this crate implements. Its keccak256 hash is the `engineId`.
pub const ENGINE_NAME: &str = "drift.eigentrust.v1";

pub fn engine_id() -> B256 {
    keccak256(ENGINE_NAME.as_bytes())
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EngineError {
    #[error("engine id {0} does not name {ENGINE_NAME}")]
    WrongEngine(B256),
    #[error("unsupported schema definition {0:?}: only all-uint256 schemas are supported")]
    UnsupportedSchema(String),
    #[error("record {uid} has timestamp {timestamp}, after the epoch boundary {t_e}")]
    RecordAfterBoundary { uid: B256, timestamp: u64, t_e: u64 },
    #[error("member set is empty: a settlement tree needs at least one leaf")]
    NoMembers,
    #[error("iterations must be at least 1")]
    NoIterations,
    #[error("alpha_ppm and epsilon_ppm must not exceed 1000000")]
    ParamOutOfRange,
}

/// Everything a settler needs from one engine run.
#[derive(Debug, Clone)]
pub struct EngineOutput {
    pub scores: BTreeMap<Address, U256>,
    pub input_digest: B256,
    pub merkle_root: B256,
    pub journal: EngineJournal,
}

/// Puts the input into canonical order: records by uid, members by (node, role), pre-trust by
/// node. Two callers holding the same attestation set in different order then hash it to the same
/// digest. Phi_c itself is order independent, so this only matters for the digest.
pub fn canonicalize(input: &mut EngineInput) {
    input.records.sort_by(|a, b| a.uid.cmp(&b.uid));
    input.members.sort_by(|a, b| (a.node, a.role).cmp(&(b.node, b.role)));
    input.pretrust.sort_by(|a, b| a.node.cmp(&b.node));
}

/// keccak256 of the ABI encoding of the canonical input (encoded as one tuple parameter, which is
/// what both `SolValue::abi_encode` and ethers' `AbiCoder.encode([tupleType], [value])` produce).
pub fn input_digest(input: &EngineInput) -> B256 {
    keccak256(input.abi_encode())
}

/// Parses an EAS-style schema definition ("uint256 score, uint256 maxScore") into its field
/// count. Only all-uint256 schemas are supported, because for those the validity rule of the
/// TypeScript reference (ethers decodes without throwing) reduces to a length check.
pub fn schema_width(definition: &str) -> Result<usize, EngineError> {
    let types: Vec<&str> = definition
        .split(',')
        .map(|f| f.trim().split(' ').next().unwrap_or(""))
        .collect();
    if types.is_empty() || types.iter().any(|t| *t != "uint256") {
        return Err(EngineError::UnsupportedSchema(definition.to_string()));
    }
    Ok(types.len())
}

/// Runs Phi_c on a canonicalized input and builds the settlement tree over the member set.
pub fn compute(input: &EngineInput) -> Result<EngineOutput, EngineError> {
    if input.engineId != engine_id() {
        return Err(EngineError::WrongEngine(input.engineId));
    }
    if input.members.is_empty() {
        return Err(EngineError::NoMembers);
    }
    if input.iterations == 0 {
        return Err(EngineError::NoIterations);
    }
    if input.alphaPpm > 1_000_000 || input.epsilonPpm > 1_000_000 {
        return Err(EngineError::ParamOutOfRange);
    }
    let width = schema_width(&input.schemaDefinition)?;
    for r in &input.records {
        if r.timestamp > input.tE {
            return Err(EngineError::RecordAfterBoundary { uid: r.uid, timestamp: r.timestamp, t_e: input.tE });
        }
    }

    let extra: Vec<Address> = input.members.iter().map(|m| m.node).collect();
    let scores = eigentrust::calculate_all(input, width, &extra);

    let leaves: Vec<B256> = input
        .members
        .iter()
        .map(|m| {
            let score = scores.get(&m.node).copied().unwrap_or(U256::ZERO);
            merkle::leaf(input.contextUID, m.node, m.role, score, input.epoch)
        })
        .collect();
    let merkle_root = merkle::standard_root(&leaves).expect("members is non-empty");
    let input_digest = input_digest(input);

    let journal = EngineJournal {
        engineId: input.engineId,
        contextUID: input.contextUID,
        epoch: input.epoch,
        tE: input.tE,
        inputDigest: input_digest,
        merkleRoot: merkle_root,
    };
    Ok(EngineOutput { scores, input_digest, merkle_root, journal })
}

/// Decodes an ABI-encoded `EngineInput` (the bytes the host writes to the guest's stdin).
pub fn decode_input(bytes: &[u8]) -> Result<EngineInput, alloy_sol_types::Error> {
    EngineInput::abi_decode(bytes)
}
