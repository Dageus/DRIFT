//! Port of `EigenTrustEngine.calculateAll` (packages/sdk/src/engines/EigenTrust.ts). Every
//! division truncates, as bigint division does in JavaScript, and every quantity is
//! non-negative, so truncation is floor. Keep the operation order identical to the reference:
//! fixed-point results depend on it.

use std::collections::BTreeMap;

use alloy_primitives::{Address, U256};
use num_bigint::BigUint;
use num_traits::Zero;

use crate::types::EngineInput;

fn scale() -> BigUint {
    BigUint::from(1_000_000_000_000_000_000u64)
}
const MULTIPLIER: u64 = 10_000;

fn to_big(v: U256) -> BigUint {
    BigUint::from_bytes_be(&v.to_be_bytes::<32>())
}

fn from_big(v: &BigUint) -> U256 {
    U256::from_be_slice(&v.to_bytes_be())
}

/// Scores every node that appears in a valid record, plus every node in `extra`. Returns an empty
/// map when no record is valid, as the reference does, so isolated members then score 0.
pub fn calculate_all(input: &EngineInput, schema_width: usize, extra: &[Address]) -> BTreeMap<Address, U256> {
    let valid: Vec<_> = input.records.iter().filter(|r| !r.revoked).collect();
    if valid.is_empty() {
        return BTreeMap::new();
    }

    // Phase 1: outbound score sums. A record is valid when ethers can decode it, which for an
    // all-uint256 schema means at least 32 bytes per field. Only the first field is the score.
    let mut nodes: std::collections::BTreeSet<Address> = extra.iter().copied().collect();
    let mut outbound: BTreeMap<Address, BTreeMap<Address, BigUint>> = BTreeMap::new();
    for r in valid {
        if r.data.len() < 32 * schema_width {
            continue;
        }
        let raw = BigUint::from_bytes_be(&r.data[..32]);
        nodes.insert(r.attester);
        nodes.insert(r.subject);
        *outbound.entry(r.attester).or_default().entry(r.subject).or_default() += raw;
    }
    if nodes.is_empty() {
        return BTreeMap::new();
    }

    // Address order equals the reference's sort of lowercase hex strings.
    let nodes: Vec<Address> = nodes.into_iter().collect();
    let n = nodes.len();
    let scale = scale();

    let row_sums: BTreeMap<Address, BigUint> =
        outbound.iter().map(|(a, m)| (*a, m.values().sum())).collect();

    // Phase 2: pre-trust vector.
    let explicit: BTreeMap<Address, BigUint> =
        input.pretrust.iter().map(|w| (w.node, to_big(w.weight))).collect();
    let default_weight = to_big(input.defaultWeight);
    let weights: Vec<BigUint> =
        nodes.iter().map(|a| explicit.get(a).cloned().unwrap_or_else(|| default_weight.clone())).collect();
    let total: BigUint = weights.iter().sum();
    let p: Vec<BigUint> = if !total.is_zero() {
        weights.iter().map(|w| w * &scale / &total).collect()
    } else {
        vec![&scale / BigUint::from(n); n]
    };

    let mut t = p.clone();
    let million = BigUint::from(1_000_000u32);
    let alpha = BigUint::from(input.alphaPpm) * &scale / &million;
    let one_minus_alpha = &scale - &alpha;
    let epsilon = BigUint::from(input.epsilonPpm) * &scale / &million;

    // Phase 3: power iteration.
    for _ in 0..input.iterations {
        let mut next = vec![BigUint::zero(); n];
        for i in 0..n {
            let src_rank = &t[i];
            if src_rank.is_zero() {
                continue;
            }
            match (row_sums.get(&nodes[i]), outbound.get(&nodes[i])) {
                (Some(row_sum), Some(row)) if !row_sum.is_zero() => {
                    for j in 0..n {
                        let s_ij = row.get(&nodes[j]).cloned().unwrap_or_default();
                        let transition = s_ij * &scale / row_sum;
                        let total = (&one_minus_alpha * transition + &alpha * &p[j]) / &scale;
                        next[j] += src_rank * total / &scale;
                    }
                }
                _ => {
                    for j in 0..n {
                        next[j] += src_rank * &p[j] / &scale;
                    }
                }
            }
        }

        let mut delta = BigUint::zero();
        for i in 0..n {
            delta += if next[i] >= t[i] { &next[i] - &t[i] } else { &t[i] - &next[i] };
        }
        t = next;
        if delta < epsilon {
            break;
        }
    }

    // Phase 4: scale to [0, MULTIPLIER].
    let mult = BigUint::from(MULTIPLIER);
    nodes.iter().zip(t.iter()).map(|(a, v)| (*a, from_big(&(v * &mult / &scale)))).collect()
}
