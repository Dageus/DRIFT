//! Tier 3 guest. Reads the ABI-encoded engine input, puts it into canonical order itself (so the
//! digest it commits does not depend on the host's ordering), runs Phi_c from drift-engine-core
//! and commits the ABI-encoded journal. The journal binds (engineId, contextUID, epoch, t_E,
//! inputDigest, merkleRoot); the image ID binds the code.

use std::io::Read;

use alloy_sol_types::SolValue;
use drift_engine_core::{canonicalize, compute, decode_input};
use risc0_zkvm::guest::env;

fn main() {
    let mut bytes = Vec::new();
    env::stdin().read_to_end(&mut bytes).expect("read input");
    let mut input = decode_input(&bytes).expect("input is not an ABI-encoded EngineInput");
    canonicalize(&mut input);
    let out = compute(&input).expect("engine rejected input");
    env::commit_slice(&out.journal.abi_encode());
}
