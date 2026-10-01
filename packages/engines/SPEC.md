# DRIFT engine protocol, version 1

This file is normative for every implementation of Phi_c that settles epochs:

- the TypeScript reference, `packages/sdk/src/engines/EigenTrust.ts` and `packages/sdk/src/engines/epoch/`;
- the Rust core, `packages/engines/core`, which the gRPC server and the RISC Zero guest both run.

The test vectors in `vectors/` pin both implementations to identical bytes. If you change a rule here, change both implementations and regenerate the vectors in the same commit.

## 1. Tiers and evidence

An engine call takes one epoch's input and returns per-node scores, the settlement Merkle root, and a **journal**. Evidence about the journal is optional. The tiers differ only in what that evidence is and who checks it.

| Tier | Where Phi_c runs | Evidence | Who checks it today |
|---|---|---|---|
| 1 | in the settler (`LocalEpochEngine`) or one remote server (`--evidence none`) | none: the settler is trusted | nobody |
| 1, attributable | one remote server (`--evidence signed`) | EIP-191 signature over `keccak256(journal)` | `GrpcEpochEngine` (signer allowlist) |
| 2 | n servers, each `--evidence signed` | t-of-n signatures over identical journal bytes | `CommitteeEpochEngine` |
| 3 | RISC Zero guest (`--evidence risc0`) | receipt for image ID `DRIFT_ENGINE_GUEST_ID` with the journal | nobody yet (see section 7) |

Every client recomputes the input digest and the Merkle root from the returned scores, whatever the tier. A server therefore cannot return scores that disagree with its root, or a root computed over a different input, without the client noticing.

## 2. Engine identity

`engineId = keccak256("drift.eigentrust.v1")`. The engine name changes whenever any rule in sections 3 to 5 changes. A new version gets a new name. The old name keeps its old meaning.

## 3. Input

The input is the Solidity struct `EngineInput` in `core/src/types.rs`:

| Field | Meaning |
|---|---|
| `engineId` | as in section 2; the engine rejects any other value |
| `contextUID`, `epoch` | the epoch being settled |
| `tE` | boundary timestamp t_E; every record must have `timestamp <= tE`, or the engine rejects the input |
| `schemaUID`, `schemaDefinition` | the attestation schema; `schemaDefinition` must consist only of `uint256` fields |
| `alphaPpm`, `epsilonPpm`, `iterations` | EigenTrust parameters; `alphaPpm, epsilonPpm <= 10^6`, `iterations >= 1` |
| `defaultWeight` | pre-trust weight of any node with no `pretrust` entry |
| `records` | the attestation set A_c^E: member-filtered, schema-filtered, up to t_E |
| `members` | admitted (node, role) pairs, at least one; one leaf each |
| `pretrust` | explicit pre-trust weights |

Two things are the caller's job and stay outside the engine: choosing `records` (the member and join-time filter of `Drift._dropPreJoinAttestations`, the snapshot at t_E) and choosing `members` (pairs held at the boundary, `assertRolesAssigned`). The input digest is what makes that choice checkable afterwards (section 6).

### 3.1 Canonical order and digest

Before hashing, sort `records` by `uid`, `members` by `(node, role)` and `pretrust` by `node`, comparing raw bytes. Lowercase hex of fixed width sorts the same way, which is what the TypeScript side uses.

```
inputDigest = keccak256(abi.encode(EngineInput))
```

`abi.encode` encodes the struct as a single tuple parameter. That is Solidity's `abi.encode(input)`, alloy's `SolValue::abi_encode`, and ethers' `AbiCoder.encode([tupleType], [value])`. Revoked records are part of the input and of the digest; Phi_c ignores them.

## 4. Phi_c: EigenTrust

All arithmetic is on unbounded non-negative integers. Every division truncates. `SCALE = 10^18` and `MULTIPLIER = 10^4`.

1. **Valid records.** Drop revoked records. If none remain, the output is the empty map, and every member scores 0. Otherwise a record is valid when `len(data) >= 32 * k`, where k is the number of schema fields. The score of a valid record is the first 32-byte word of `data`, as a big-endian unsigned integer. Records that fail this test are skipped.
2. **Nodes.** The node set is every member's node plus the attester and subject of every valid record, ordered by address bytes. Let n be its size.
3. **Edges.** `s[i][j]` is the sum of the scores of the valid records from node i to node j. `rowSum[i] = sum_j s[i][j]`.
4. **Pre-trust.** `w[i]` is node i's `pretrust` weight, or `defaultWeight` when it has none. Let `W = sum_i w[i]`. Then `p[i] = w[i] * SCALE / W` when `W > 0`, and `p[i] = SCALE / n` otherwise.
5. **Parameters.**
   - `alpha = alphaPpm * SCALE / 10^6`
   - `oneMinusAlpha = SCALE - alpha`
   - `eps = epsilonPpm * SCALE / 10^6`
6. **Iteration.** Start with `t = p`. Repeat up to `iterations` times:
   - `next = 0`.
   - For each i with `t[i] != 0`:
     - if `rowSum[i] > 0`, then for each j, `next[j] += t[i] * ((oneMinusAlpha * (s[i][j] * SCALE / rowSum[i]) + alpha * p[j]) / SCALE) / SCALE`;
     - otherwise, for each j, `next[j] += t[i] * p[j] / SCALE`.
   - `delta = sum_i |next[i] - t[i]|`; `t = next`; stop if `delta < eps`.
7. **Output.** `score[i] = t[i] * MULTIPLIER / SCALE`.

The parenthesization in step 6 is part of the definition, because truncation makes the result depend on it.

## 5. Settlement tree

For each member `(node, role)` the leaf is

```
leaf = keccak256(keccak256(abi.encode(contextUID, node, role, score[node] or 0, epoch)))
```

The tree is OpenZeppelin's `StandardMerkleTree`, as built by `StandardMerkleTree.of`:

- sort the leaves ascending;
- place them at the end of an array of size 2m-1 in reverse order;
- set node i to `keccak256(sort(child 2i+1, child 2i+2))`.

This is the tree `DriftSettler.buildAndSignEpochRoot` builds and `DRIFTClient` verifies, so the engine's root is the root the settler posts.

## 6. Journal

```
struct EngineJournal { bytes32 engineId; bytes32 contextUID; uint256 epoch; uint64 tE; bytes32 inputDigest; bytes32 merkleRoot; }
journal = abi.encode(EngineJournal)
```

Evidence of every tier covers exactly these bytes. A journal states: "running engine `engineId` on the input with digest `inputDigest` gives `merkleRoot` for `(contextUID, epoch)` at boundary `tE`". It does not say that the input was the right one. Anyone who rebuilds A_c^E from EAS can recompute the digest and compare. Making that comparison enforceable on chain is future work: for example, a challenge that reveals a record missing from the input.

## 7. Status and open work

- **Tier 3 on chain.** The guest commits the journal. The server can produce succinct receipts but returns no on-chain seal yet. To settle on chain with a proof we still need:
  - `ProverOpts::groth16()` plus `risc0_ethereum_contracts::encode_seal` in the server;
  - a `postEpochRoot` branch in `DRIFTCore` that calls the RISC Zero verifier router with the pinned image ID and `sha256(journal)`, then checks the journal fields against its arguments.
- **Tier 2 on chain.** The committee signatures exist, but no contract checks them yet. Two ways to do that are an ERC-1271 committee wallet as the trusted settler, or a t-of-n check in `postEpochRoot`.
- **Cost.** Phi_c is O(n^2 * iterations) on big integers. That is cheap natively and expensive in the zkVM. Executor cycle counts for the vectors (`RISC0_DEV_MODE=1`, RISC Zero 3.0.6):

  | vector | nodes | records | max iterations | cycles | segments |
  |---|---|---|---|---|---|
  | triangle | 3 | 3 | 10 | 1.1M | 2 |
  | edge-cases | 5 | 7 | 10 | 2.6M | 3 |
  | random-40 | 40 | 300 | 30 | 181M | 173 |

  A real succinct proof of `triangle` took 8 minutes of wall time (71 CPU-minutes) on a 12-core laptop CPU, and the server confirmed the guest journal against its own result. Proving time grows roughly with the segment count, so `random-40` would take hours on the same machine.

  At 40 nodes that is at least 3,800 cycles per inner-loop step (fewer iterations would mean more per step), almost all of it `BigUint` arithmetic. Tier 3 is not practical at protocol scale as written. Two changes are needed before it is:
  - fixed-width `u128`/`U256` arithmetic with a specified overflow bound on scores, which changes the spec, so it gets a new engine name;
  - a sparse inner loop: the `alpha * p[j]` term is the same for every source with a non-zero row, so it can be summed once per iteration. This also changes truncation, so it too needs a new engine name.
- **Schemas.** Only all-`uint256` schemas are in scope. For those, the validity rule (ethers decodes without throwing) reduces to a length check. Supporting other types means specifying ethers' decode failures exactly.

## 8. Why Tier 2 is a committee, not SMPC

Secure multi-party computation hides each party's inputs from the others. Phi_c's inputs are public EAS attestations, so there is nothing to hide, and SMPC would add its cost without adding a property we need. What Tier 2 needs is that no single operator decides the root. n independent operators recomputing a deterministic function, plus a t-of-n check on identical journals, gives exactly that. SMPC becomes worth it only if the protocol adds private inputs, such as viewer-private trust weights in global settlement.

## 9. Test vectors

`vectors/*.json` hold the input in caller order and the expected digest, root, journal bytes and scores.

- `packages/sdk/test/local/engine-vectors.test.ts` writes them from the TypeScript reference (`UPDATE_ENGINE_VECTORS=1`) and checks them.
- `core/tests/vectors.rs` checks the Rust core against them.
- `packages/sdk/test/local/engine-grpc.test.ts` checks the running server against the TypeScript client.
