# Changelog

All notable changes to `@drift-network/sdk` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package has not yet cut a `0.1.0`
release (still `"private": true`), so everything so far lives under **Unreleased**.

## [Unreleased]

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
