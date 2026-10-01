//! Checks the Rust core against the vectors the TypeScript reference wrote
//! (packages/sdk/test/local/engine-vectors.test.ts). A failure here means the two
//! implementations of Phi_c disagree, which would make Tier 3 proofs settle different roots
//! than Tier 1.

use std::{fs, path::Path, str::FromStr};

use alloy_primitives::{hex, Address, Bytes, B256, U256};
use alloy_sol_types::SolValue;
use drift_engine_core::{canonicalize, compute, decode_input, engine_id, EngineInput, Member, Record, Weight};
use serde_json::Value;

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("expected string, got {v}"))
}
fn b256(v: &Value) -> B256 {
    B256::from_str(s(v)).unwrap()
}
fn addr(v: &Value) -> Address {
    Address::from_str(s(v)).unwrap()
}
fn uint(v: &Value) -> U256 {
    match v {
        Value::Number(n) => U256::from(n.as_u64().unwrap()),
        _ => U256::from_str_radix(s(v), 10).unwrap(),
    }
}
fn u32_of(v: &Value) -> u32 {
    v.as_u64().unwrap() as u32
}

fn input_of(v: &Value) -> EngineInput {
    let p = &v["params"];
    EngineInput {
        engineId: engine_id(),
        contextUID: b256(&v["contextUID"]),
        epoch: uint(&v["epoch"]),
        tE: uint(&v["tE"]).to(),
        schemaUID: b256(&v["schemaUID"]),
        schemaDefinition: s(&v["schemaDefinition"]).to_string(),
        alphaPpm: u32_of(&p["alphaPpm"]),
        epsilonPpm: u32_of(&p["epsilonPpm"]),
        iterations: u32_of(&p["iterations"]),
        defaultWeight: uint(&v["defaultWeight"]),
        records: v["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| Record {
                uid: b256(&r["uid"]),
                attester: addr(&r["attester"]),
                subject: addr(&r["subject"]),
                timestamp: r["timestamp"].as_u64().unwrap(),
                revoked: r["revoked"].as_bool().unwrap(),
                data: Bytes::from(hex::decode(s(&r["data"])).unwrap()),
            })
            .collect(),
        members: v["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| Member { node: addr(&m["node"]), role: b256(&m["role"]) })
            .collect(),
        pretrust: v["pretrust"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| Weight { node: addr(&w["node"]), weight: uint(&w["weight"]) })
            .collect(),
    }
}

#[test]
fn rust_core_matches_typescript_reference() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../vectors");
    let mut checked = 0;
    for entry in fs::read_dir(&dir).expect("vectors directory") {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let name = s(&v["name"]).to_string();

        let mut input = input_of(&v["input"]);
        // The vectors store the caller's order; the core must reach the same digest after
        // canonicalizing, as the guest does.
        canonicalize(&mut input);
        let out = compute(&input).unwrap_or_else(|e| panic!("{name}: {e}"));

        let exp = &v["expected"];
        assert_eq!(out.input_digest, b256(&exp["inputDigest"]), "{name}: input digest");
        assert_eq!(out.merkle_root, b256(&exp["merkleRoot"]), "{name}: merkle root");
        assert_eq!(
            hex::encode_prefixed(out.journal.abi_encode()),
            s(&exp["journal"]),
            "{name}: journal"
        );
        let expected: Vec<(Address, U256)> = exp["scores"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (Address::from_str(k).unwrap(), uint(v)))
            .collect();
        let actual: Vec<(Address, U256)> = out.scores.into_iter().collect();
        assert_eq!(actual, expected, "{name}: scores");

        // The bytes the host writes to the guest decode back to the same input.
        assert_eq!(decode_input(&input.abi_encode()).unwrap(), input, "{name}: ABI round trip");
        checked += 1;
    }
    assert!(checked >= 6, "expected at least 6 vectors, found {checked}");
}
