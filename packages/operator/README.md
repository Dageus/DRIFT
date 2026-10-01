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

#### Rounds

An epoch is attempted in rounds 0, 1, ... at one Safe nonce. The signed proposal (`EpochProposal`) carries `round`, and `proposalId = keccak256(abi.encode(client, contextUID, epoch, safeNonce, round))`, so each round has its own commitments, reveals and signatures. Every owner judges a round the same way, from the relay and the clock (`roundStatusTier2`):

- **open** until its reveal deadline;
- **agreed** after it, if at least `threshold` valid reveals agree on a root;
- **dead** after it otherwise, including when fewer than `threshold` reveals arrived at all.

Round r+1 may be proposed (`proposeEpochTier2({ ..., round })`), and committed to, only while round r is dead. The current round (`latestRoundTier2`) is the highest round whose predecessors are all dead, so a round written early by an owner ignoring the rule is not followed. An agreed round is never abandoned however slowly it publishes and signs, and a root already executed on chain ends the epoch. The daemon proposes the next round automatically and stops with an error alert after `tier2.maxRounds` (default 5) dead rounds.

The proposal announces only the epoch and the deadlines, never the root. Owners commit to their own root before any reveal exists. An owner whose root differs from the agreed one cannot publish or sign, and `executeEpochTier2` counts only signatures from owners with a matching, timely reveal. `FileSettlementRelay` suits owners who share a directory; any `ISettlementRelay` implementation works, and the relay is not trusted.

### Remote and committee engines

`GrpcEpochEngine` calls an engine server over the protocol in `packages/protos/drift/engine/v1`. The Rust server is in `packages/engines`, and `packages/engines/SPEC.md` defines the protocol. The client treats the server as untrusted: it recomputes the input digest and the Merkle root from the returned scores, and checks the journal and any signature. `CommitteeEpochEngine` gathers t-of-n signed journals from several such servers as an off-chain audit trail.

## Daemon and API

`drift-operator run --config operator.json` runs a reconcile loop over the configured contexts, with one or more roles each: `tier1` (settle, answer challenges, withdraw bonds), `tier2-owner` (drive the Tier 2 round as one Safe owner) and `watcher` (recompute every posted root, report divergence and omissions, optionally challenge). Keys are named by environment variable in the config and never written in it.

With `api` configured, the daemon also serves HTTP. The API holds no keys and signs nothing:

| Route | Returns |
|---|---|
| `GET /health` | liveness |
| `GET /ready` | 503 until a tick has completed recently and the RPC answers |
| `GET /status` | per context: current epoch, last settlement, challenges, Tier 2 round, watcher finding, `pendingPayouts(trustedSettler)`, alerts |
| `GET /contexts/:ctx/epochs/:epoch` | committed root, `treeURI`, dispute window, open challenges, bond, finalized |
| `GET /contexts/:ctx/epochs/:epoch/proofs/:node` | the node's leaves and proofs from this operator's tree store |
| `GET /metrics` | Prometheus text |

Proofs are unverified operator data (header `x-drift-trust: unverified`). Check each against `epochRoots(epoch)` before use; the contract does so anyway on claims and votes.

### Tier 2 relay over HTTP

With `api.serveRelay`, the API also serves the settlement relay under `/relay/v1`, backed by `relay.dir`, and other owners point `relay: { "kind": "http", "url": ... }` at it. Semantics match `FileSettlementRelay`: append-only, first-writer-wins (409 on a different rewrite), identical rewrites succeed. Reads are open. Writes are authenticated: each carries an EIP-191 signature by a Safe owner over the method, path and body (`relayRequestDigest`), and a message naming an owner must be written by that owner. Readers still verify every message themselves, so this is not about trusting relay content; it exists because first-writer-wins makes the first write to a slot permanent, and an unauthenticated relay would let anyone stall a round by writing junk first.

## Recording

With `recorder: { "dir": ..., "runId": ..., "process": ... }` in the config, the daemon writes an append-only event log: one JSON object per line, one file per process (`<runId>.<process>.<pid>.jsonl`), fsynced after every line. Several daemons can record into one directory; they never share a file. Recording is off by default, and a failing recorder never stops a job.

Every event carries the schema version (`v: 1`), run id, process, a per-process sequence number, wall time in milliseconds, and where they apply the context, tier, epoch, round, chain time and block. The types (`EVENT_FIELDS` in `src/recorder/events.ts`, checked by `validateEvent`) cover:

- settlement: `epoch.due` (chain time = t_E), `o1.checked`, `snapshot.done` (record and member counts), `root.computed` (N and compute time), `tree.uploaded`, `tree.pinned`, `settle.posted`, `epoch.posted`, `epoch.finalized`, `bond.withdrawn`;
- Tier 2: `tier2.proposed`, `tier2.committed`, `tier2.revealed`, `tier2.published`, `tier2.signed`, `tier2.executed`, `tier2.round_outcome`;
- disputes: `challenge.detected`, `challenge.answered`, `challenge.unanswerable`, `challenge.expired`, and the watcher's `watch.root_seen`, `watch.recomputed`, `watch.divergence`, `watch.challenge_opened`, `watch.challenge_skipped`, `challenge.claimed`;
- transactions: `tx.sent` and `tx.mined` for every transaction the settler key or the hot wallet sends, labeled by action (`settle.post`, `challenge.respond`, `bond.withdraw`, `tier2.execute`, `challenge.open`), with `gasUsed`, the effective gas price and the fee from the receipt;
- client side, for the experiment driver: `client.attest`, `client.claim`, `client.vote`.

The same events feed Prometheus metrics on `/metrics`: latency histograms (`LATENCIES`: O1 wait, snapshot, compute, upload, pin, settlement, transaction inclusion, finalization, bond withdrawal, Tier 2 rounds, challenge detection and response, watcher detection and recomputation) and counters of gas, fees, transactions and Tier 2 round outcomes. The offline analysis uses the same definitions, so a live dashboard and the tables agree.

The recorder is exported for reuse (`Recorder`, `JsonlSink`, `MetricsSink`, `RecordingWallet`, `validateEvent`).

## API module

The HTTP API is a separate entry point, `@drift-network/operator/api`, and Fastify is an optional dependency. The daemon imports the API only when the config has an `api` section, so an operator without one never loads Fastify.

## Tests

```sh
npm test                                   # hermetic
DRIFT_E2E_ANVIL=1 npm test -- pipeline-anvil   # anvil, real contracts and Safe; needs anvil and forge
```

The gRPC tests run when the Rust server is built (`cargo build` in `packages/engines`).
