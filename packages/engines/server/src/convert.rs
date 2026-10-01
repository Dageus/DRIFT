//! Wire messages to and from the core's ABI types. All length and range checks on untrusted
//! input happen here, so the core can assume well-formed values.

use alloy_primitives::{Address, Bytes, B256, U256};
use drift_engine_core::{EngineInput, EngineOutput, Member, Record, Weight};
use tonic::Status;

use crate::pb;

fn b256(field: &str, v: &[u8]) -> Result<B256, Status> {
    B256::try_from(v).map_err(|_| Status::invalid_argument(format!("{field}: expected 32 bytes, got {}", v.len())))
}

fn address(field: &str, v: &[u8]) -> Result<Address, Status> {
    Address::try_from(v).map_err(|_| Status::invalid_argument(format!("{field}: expected 20 bytes, got {}", v.len())))
}

fn uint(field: &str, v: &str) -> Result<U256, Status> {
    if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Status::invalid_argument(format!("{field}: expected a decimal integer, got {v:?}")));
    }
    U256::from_str_radix(v, 10).map_err(|_| Status::invalid_argument(format!("{field}: does not fit in uint256")))
}

pub fn input_from_request(req: pb::ComputeEpochRequest) -> Result<EngineInput, Status> {
    let params = req.params.ok_or_else(|| Status::invalid_argument("params: missing"))?;
    let records = req
        .records
        .into_iter()
        .map(|r| {
            Ok(Record {
                uid: b256("records.uid", &r.uid)?,
                attester: address("records.attester", &r.attester)?,
                subject: address("records.subject", &r.subject)?,
                timestamp: r.timestamp,
                revoked: r.revoked,
                data: Bytes::from(r.data),
            })
        })
        .collect::<Result<_, Status>>()?;
    let members = req
        .members
        .into_iter()
        .map(|m| Ok(Member { node: address("members.node", &m.node)?, role: b256("members.role", &m.role)? }))
        .collect::<Result<_, Status>>()?;
    let pretrust = req
        .pretrust
        .into_iter()
        .map(|w| Ok(Weight { node: address("pretrust.node", &w.node)?, weight: uint("pretrust.weight", &w.weight)? }))
        .collect::<Result<_, Status>>()?;

    Ok(EngineInput {
        engineId: b256("engine_id", &req.engine_id)?,
        contextUID: b256("context_uid", &req.context_uid)?,
        epoch: uint("epoch", &req.epoch)?,
        tE: req.t_e,
        schemaUID: b256("schema_uid", &req.schema_uid)?,
        schemaDefinition: req.schema_definition,
        alphaPpm: params.alpha_ppm,
        epsilonPpm: params.epsilon_ppm,
        iterations: params.iterations,
        defaultWeight: uint("default_weight", &req.default_weight)?,
        records,
        members,
        pretrust,
    })
}

pub fn response_from_output(out: &EngineOutput, journal: Vec<u8>) -> pb::ComputeEpochResponse {
    pb::ComputeEpochResponse {
        scores: out
            .scores
            .iter()
            .map(|(node, score)| pb::NodeScore { node: node.to_vec(), score: score.to_string() })
            .collect(),
        input_digest: out.input_digest.to_vec(),
        merkle_root: out.merkle_root.to_vec(),
        journal,
        evidence: None,
    }
}
