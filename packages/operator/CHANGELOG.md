# Changelog

All notable changes to `@drift-network/operator` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The package is `"private": true` and
unpublished; versions follow the repository tags.

## [Unreleased]

### Changed
- Tier 2 proposals carry a `round` (signed in `EpochProposal`), and
  `tier2ProposalId(client, contextUID, epoch, safeNonce, round)` hashes it. A round with no quorum
  by its reveal deadline is dead and is replaced by the next round (`roundStatusTier2`,
  `latestRoundTier2`); previously a failed round stalled the epoch until the Safe nonce moved.
  Proposals written before this change do not verify.

### Added
- Operator daemon (`drift-operator run --config`), roles `tier1`, `tier2-owner` and `watcher`.
- HTTP API (`buildApi`): health, readiness, status, epochs, proofs, metrics; and the Tier 2 relay
  over HTTP (`registerRelayRoutes`, `HttpSettlementRelay`) with owner-signed writes.
- New package. Takes over from `@drift-network/sdk` everything that produces settlements: the
  settlement pipeline (`loadEpochSnapshot`, `settleEpochTier1`, the Tier 2 steps, relays), the Safe
  settler, `GrpcEpochEngine` and `CommitteeEpochEngine`, and `LocalTreeStore`. Code and tests are
  unchanged apart from imports, which now go through the SDK's public entry points.
- The engine protocol definition is bundled at build time (`proto/`), so `GrpcEpochEngine` works
  from an installed copy, not only inside the repository.
