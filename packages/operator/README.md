# DRIFT Operator

Node-only tooling for the parties that produce settlements: a Tier 1 settler, the owners of a Tier 2 Safe, and watchers. It builds on [`@drift-network/sdk`](../sdk/README.md), which covers the consuming side (claims, votes, disputes, local mode, tree resolution).

| Area | Exports |
|---|---|
| Pipeline | `loadEpochSnapshot`, `loadBoundaryMembership`, `settleEpochTier1`, the Tier 2 steps (`proposeEpochTier2` ... `executeEpochTier2`), `ISettlementRelay`, `FileSettlementRelay`, the commit-reveal message helpers |
| Safe | `SafeSettler`, `SAFE_V141`, Safe transaction and message hashing |
| Engines | `GrpcEpochEngine` (an engine server, checked as untrusted), `CommitteeEpochEngine` (t-of-n signed journals) |
| Store | `LocalTreeStore`, the filesystem copy of each tree a settler keeps to answer challenges |

The engine protocol definition is bundled with the package (`proto/`, copied from `packages/protos` at build time).

## Keys

An operator handles up to three kinds of key, and the pipeline never needs them in one place:

| Key | Used for | Funds |
|---|---|---|
| Settler key (Tier 1) | `postEpochRoot`, which only `trustedSettler` may call | gas and the settlement bond |
| Safe owner keys (Tier 2) | off-chain signatures: proposal, commitment, reveal, Safe transaction | none |
| Hot wallet | `respondToChallenge`, executing the Safe transaction, `withdrawSettlementBond`; the contract lets anyone call these | gas only |

## Settling an Epoch

Settlement reads the chain as it stood at the epoch boundary t_E, so every party that settles or checks an epoch gets the same input.

`loadEpochSnapshot` builds the engine input for one epoch. It refuses to run until the provider's finalized head is past t_E (O1). It then fetches the attestations as of t_E, keeps one schema, and rebuilds membership at t_E from the registry's events. The result is the attestations between members and every (node, role) pair held at t_E: one leaf each, matching exactly the pairs the contract would accept an omission challenge for. Pass `fromBlock` as the core's deployment block on RPCs that limit log ranges. A `fromBlock` after the context was created would drop members and cost the settlement bond, so the SDK refuses one.

### Tier 1

```ts
import { DriftSettler } from '@drift-network/sdk';
import { LocalEpochEngine } from '@drift-network/sdk/engines';
import { IPFSTreeTransport } from '@drift-network/sdk/merkle';
import { LocalTreeStore, loadEpochSnapshot, settleEpochTier1 } from '@drift-network/operator';

const snapshot = await loadEpochSnapshot({ provider, client, epoch, attestations, schemaUID, fromBlock });
const { root, treeURI, txHash } = await settleEpochTier1({
  settler: new DriftSettler(settlerSigner), // must be the client's trustedSettler
  client,
  snapshot,
  engine: new LocalEpochEngine(),
  transport: new IPFSTreeTransport({ apiUrl }),
  store: new LocalTreeStore('./trees') // keep a copy to answer challenges
});
```

`settleEpochTier1` computes the root, uploads the tree in canonical form, pins it and saves it locally, all before posting with the client's settlement bond.

### Tier 2

Each Safe owner runs the same steps with its own engine and its own view of the chain. Every step can be called repeatedly and never blocks: it returns `'waiting'` until its window opens, `'done'` when it acts, and `'already-done'` afterwards, so a scheduler can drive it.

```ts
import {
  SafeSettler, FileSettlementRelay, proposeEpochTier2, commitEpochTier2, revealEpochTier2,
  publishEpochTreeTier2, signEpochTier2, executeEpochTier2
} from '@drift-network/operator';

const base = { safeSettler: new SafeSettler(provider, safe, client), relay: new FileSettlementRelay('./relay') };
const compute = { snapshot: { provider, attestations, schemaUID, fromBlock }, engine: new LocalEpochEngine() };

const { proposalId } = await proposeEpochTier2({ ...base, proposer: owner, epoch });   // any owner
await commitEpochTier2({ ...base, owner, proposalId, compute });                         // before the commit deadline
await revealEpochTier2({ ...base, owner, proposalId, compute });                         // after it
await publishEpochTreeTier2({ ...base, owner, proposalId, compute, transport, store });  // once t reveals agree
await signEpochTier2({ ...base, owner, proposalId, transport, store });                  // checks and pins the tree first
await executeEpochTier2({ ...base, sender: anyone, proposalId });                       // anyone with gas
```

The proposal announces only the epoch and the deadlines, never the root. Owners commit to their own root before any reveal exists. An owner whose root differs from the agreed one cannot publish or sign, and `executeEpochTier2` counts only signatures from owners with a matching, timely reveal. `FileSettlementRelay` suits owners who share a directory; any `ISettlementRelay` implementation works, and the relay is not trusted.

### Remote and committee engines

`GrpcEpochEngine` calls an engine server over the protocol in `packages/protos/drift/engine/v1`. The Rust server is in `packages/engines`, and `packages/engines/SPEC.md` defines the protocol. The client treats the server as untrusted: it recomputes the input digest and the Merkle root from the returned scores, and checks the journal and any signature. `CommitteeEpochEngine` gathers t-of-n signed journals from several such servers as an off-chain audit trail.

## Tests

```sh
npm test                                   # hermetic
DRIFT_E2E_ANVIL=1 npm test -- pipeline-anvil   # anvil, real contracts and Safe; needs anvil and forge
```

The gRPC tests run when the Rust server is built (`cargo build` in `packages/engines`).
