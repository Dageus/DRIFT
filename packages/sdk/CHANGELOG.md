# Changelog

All notable changes to `@drift-network/sdk` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The package is still `"private": true`
and unpublished, so versions follow the repository tags (`v1.0.0`, ...), not npm releases.

## [Unreleased]

### Removed (moved to `@drift-network/operator`)
- The `/pipeline`, `/safe` and `/engines/remote` subpaths, and `LocalTreeStore` from `/merkle`.
  They produce settlements and need Node, so they now live in the operator package, which builds
  on this one. Imports change from `@drift-network/sdk/{pipeline,safe,engines/remote}` to
  `@drift-network/operator`. `@grpc/grpc-js` and `@grpc/proto-loader` are no longer dependencies.

### Added
- Root exports `ReputationModule`, `filterContextRecords` and `JoinTimes`, and `journalHash` in
  `/engines`, which the operator package uses.

## [1.1.0] (repository tag `v1.1.0`)

### Added
- `@drift-network/sdk/pipeline`: `loadEpochSnapshot` builds an epoch's engine input from chain
  state at the boundary t_E, after the O1 check on the finalized head. It rebuilds membership at
  t_E from the registry's events, so the leaf set is exactly the set of challengeable pairs.
  `settleEpochTier1` computes, uploads, pins and stores the tree, then signs and posts with the
  bond. The Tier 2 steps (`proposeEpochTier2`, `commitEpochTier2`, `revealEpochTier2`,
  `publishEpochTreeTier2`, `signEpochTier2`, `executeEpochTier2`) settle through a Safe with
  commit-reveal among its owners, over an `ISettlementRelay` (`FileSettlementRelay`).
- `@drift-network/sdk/safe`: `SafeSettler` and helpers to settle with a t-of-n Safe v1.4.1 as
  the ERC-1271 trusted settler, in one round (MultiSend + SignMessageLib) or two.
- `IEpochEngine`, `LocalEpochEngine` and the engine protocol helpers in `/engines`; the
  `GrpcEpochEngine` and `CommitteeEpochEngine` remote engines in `/engines/remote`, for the Rust
  engine server in `packages/engines`.
- `/merkle`: `buildEpochTree` (canonical order and case, so identical scores give identical
  bytes and CIDs), `checkEpochTree`, `loadEpochTree`, `findLeaves`, `resolveEpochTree` (chain
  state to a checked tree, handling rolled-back epochs), and `IPFSTreeTransport.pin`.
- `IMerkleStore.loadLeaves`, and an optional `role` on `loadLeaf`.
- `checkEpochSynchronized`, the O1 check without a signer.
- `DriftEngineError` for engine output that fails verification.

### Changed
- `ITreeTransport.fetchTree(treeURI, expected?)` checks the fetched tree and, given the
  committed root, rejects any other tree. `ITreeTransport` gains an optional `pin`.
- `LocalTreeStore.loadLeaf` throws when the node holds several roles and no role is given,
  instead of returning the first leaf; it also checks trees it loads from disk and rejects a
  `contextUID` that is not bytes32.
- `DriftSettler.buildAndSignEpochRoot` builds the tree with `buildEpochTree`. The root is
  unchanged; the dumped tree is now canonical. Proof helpers compare hex case-insensitively.
- `ReputationModule.postEpochRoot` returns the transaction hash.
- Local mode's member filter is now the shared `filterContextRecords`; behaviour is unchanged.
- Breaking for custom `IMerkleStore` implementations only: `loadLeaves` is a new required method.

### Fixed
- `IPFSTreeTransport.fetchTree` returned any tree a gateway served without checking it.
- The tests, scenarios and scripts outside `src/` typecheck again (49 errors, including a test
  typed against a renamed settler internal).


## [1.0.0] (repository tag `v1.0.0`)

### Added
- `Drift` entry point routing `getReputation` across `global` (on-chain balance), `local`
  (subjective, viewer-computed) and `voting` (Merkle-proven governance power) modes.
- `DriftSettler`: epoch root construction/signing, O1 synchronization check
  (`isSynchronizedForEpoch`/`assertSynchronizedForEpoch`), Proof-of-State payload generation,
  role-assignment precondition check (`assertRolesAssigned`), B1 challenge-response proof
  generation (`generateChallengeResponse`).
- `ReputationModule`: full B1 non-inclusion dispute surface — `challengeOmission`,
  `respondToChallenge`, `claimUnansweredChallenge`, `reclaimMootChallenge`,
  `withdrawSettlementBond`.
- `GovernanceModule`: proposal/voting lifecycle, and explicit node role management
  (`assignRole`, `revokeRole`, `hasNodeRole`, `getNodeRoles`) matching the contracts' move away
  from implicit role-on-mint.
- Reputation engines: `EigenTrustEngine`, `TemporalDecayEngine`, `WeightedLocalEngine`, selectable
  via `REPUTATION_ENGINES`.
- `EASProvider` (`IAttestationProvider` implementation for EAS), with join-time filtering
  mirroring the on-chain rejoin-exploit fix.
- `IAttestationProvider.fetchAllContextRecords` — fetches the full context attestation graph
  (schema-scoped, paginated), not just one subject's incoming edges, enabling genuine multi-hop
  reputation propagation. `Drift._getLocalReputation` now uses it unconditionally; `EigenTrustEngine`
  computes real indirect trust over the full graph instead of a single-subject star graph.
- `LocalTrustStore` (browser) / `NodeTrustStore` (filesystem) — environment-appropriate subjective
  trust-weight persistence, picked automatically by `Drift`'s constructor.
- `LocalTreeStore` — local Merkle tree persistence for settler/oracle-side tooling.
- `IPFSTreeTransport` / `ITreeTransport` — publishes and resolves the `treeURI` field
  `postEpochRoot`/`EpochRootPosted` carry but never store or dereference on-chain. `uploadTree`
  matches `buildAndSignEpochRoot`'s `uploader` parameter directly; `fetchTree` resolves an
  on-chain-observed `treeURI` back into a tree. See `examples/treeuri-ipfs.ts`.
- Typed error hierarchy (`DriftError` and 6 subclasses) with structured revert decoding
  (`DriftContractRevertError` carries `revertName`/`revertArgs`).
- Subpath exports: `/engines`, `/providers`, `/trust`, `/merkle`, alongside the core `Drift`/
  `DriftSettler`/`SchemaEncoder`/error-hierarchy exports at the package root.

### Fixed
- `package.json` `exports` map pointed at build outputs that didn't exist (`./engines`,
  `./providers`); most of the SDK's own modules weren't reachable from the public entry point at
  all.
- Compiled output didn't run under plain Node (`moduleResolution: "bundler"` allowed
  extensionless relative imports that only a bundler, not Node's native ESM loader, can resolve).
- `ReputationModule.postEpochRoot` didn't send the settlement bond `postEpochRoot` has required
  on-chain since B1 shipped — every call reverted with `InsufficientBond`.
- `GovernanceModule`/`ReputationModule` were built against narrow interface ABIs missing
  `getActiveRoles` and ~30 of the concrete client's custom errors, breaking both a real method
  call and most revert decoding.
- O1 synchronization check and epoch/dispute-window reads moved from `block.number` to
  `block.timestamp`, matching the contracts' move to timestamp-based epoch boundaries (portability
  across L2s with non-standard block semantics).

### Changed
- Settlement flows built for a node/role pair now fail fast client-side
  (`DriftSettler.assertRolesAssigned`) instead of only on-chain, once role assignment became
  explicit rather than implicit-on-reward.
- `IReputationEngine.calculateScore` now takes a required `subject` parameter — engines previously
  had no reliable way to know which node's score a multi-subject record set should resolve to.
