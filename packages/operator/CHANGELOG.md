# Changelog

All notable changes to `@drift-network/operator` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The package is `"private": true` and
unpublished; versions follow the repository tags.

## [Unreleased]

### Added
- New package. Takes over from `@drift-network/sdk` everything that produces settlements: the
  settlement pipeline (`loadEpochSnapshot`, `settleEpochTier1`, the Tier 2 steps, relays), the Safe
  settler, `GrpcEpochEngine` and `CommitteeEpochEngine`, and `LocalTreeStore`. Code and tests are
  unchanged apart from imports, which now go through the SDK's public entry points.
- The engine protocol definition is bundled at build time (`proto/`), so `GrpcEpochEngine` works
  from an installed copy, not only inside the repository.
