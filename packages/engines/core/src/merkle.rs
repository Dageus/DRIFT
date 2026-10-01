//! OpenZeppelin `StandardMerkleTree` root, bit-compatible with `@openzeppelin/merkle-tree` and
//! with `MerkleProof.verify` on chain. The settler builds its tree with
//! `StandardMerkleTree.of(values, ['bytes32','address','bytes32','uint256','uint256'])`.

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::SolValue;

/// Leaf H(H(c ‖ n ‖ r ‖ score ‖ E)), with ‖ meaning abi.encode.
pub fn leaf(context_uid: B256, node: Address, role: B256, score: U256, epoch: U256) -> B256 {
    let inner = keccak256((context_uid, node, role, score, epoch).abi_encode_params());
    keccak256(inner)
}

fn hash_pair(a: B256, b: B256) -> B256 {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(lo.as_slice());
    buf[32..].copy_from_slice(hi.as_slice());
    keccak256(buf)
}

/// Root of the tree `StandardMerkleTree.of` builds: leaves sorted ascending, laid out at the end
/// of a 2n-1 array in reverse order, parents at i from children 2i+1 and 2i+2.
pub fn standard_root(leaves: &[B256]) -> Option<B256> {
    if leaves.is_empty() {
        return None;
    }
    let mut sorted = leaves.to_vec();
    sorted.sort();
    let n = sorted.len();
    let mut tree = vec![B256::ZERO; 2 * n - 1];
    for (i, l) in sorted.iter().enumerate() {
        tree[2 * n - 2 - i] = *l;
    }
    for i in (0..n - 1).rev() {
        tree[i] = hash_pair(tree[2 * i + 1], tree[2 * i + 2]);
    }
    Some(tree[0])
}
