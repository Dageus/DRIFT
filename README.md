# DRIFT

Decentralized Reputation Infrastructure for Trust

![Solidity](https://img.shields.io/badge/Solidity-0.8.28-purple?style=flat-square&logo=solidity&logoColor=white&labelColor=%23DBA507&color=%237B1FA2)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Ethereum](https://img.shields.io/badge/Ethereum-3C3C3D?logo=ethereum&logoColor=white)
![Foundry](https://img.shields.io/badge/Built%20with-Foundry-orange?style=flat-square)

## Introduction

DRIFT is a protocol that treats reputation as a scalable, context-scoped primitive. By moving heavy algorithmic trust computations off-chain and utilizing succinct state proofs for on-chain settlement, DRIFT achieves constant-cost global updates and fast user verification without expanding ledger storage footprints.

The protocol is built on three design principles:

**Context Isolation.** Reputation is strictly scoped to a unique administrative domain. A node's score in a P2P storage network is isolated from its score in a governance DAO, preventing cross-domain correlation.

**Attestation-Source Agnosticism.** The core ledger does not depend on a rigid attestation primitive. Any registry implementing the `IAttestationProvider` interface can be bound into a context as an authorized data stream.

**Off-Chain Computation, On-Chain Verification.** Graph-based algorithms (e.g., EigenTrust) execute off-chain. Validated outputs are committed to the ledger via low-gas cryptographic proofs (EIP-712 signatures or zero-knowledge proofs).

## Core Concepts

### Context

A context is a unique, namespaced reputation domain registered permissionlessly. Each context dictates its verification profile: accepted attestation schemas, evaluation adapters, and administrators (via OpenZeppelin AccessControl). Context identifiers (`contextUID`) are derived deterministically via `keccak256(abi.encodePacked(name))`.

### Schema

A schema defines the data fields of an identity claim. DRIFT does not manage global schema registries; it stores a whitelist of `schemaUID` values accepted within each context.

### Adapter

An adapter is an on-chain contract implementing `IAttestationProvider`. It translates attestation data from external registries into a Boolean `isValid()` response. DRIFT ships with a natively integrated EAS adapter.

### Node

Any cryptographic identity (wallet, device, or smart contract) that registers within a context to participate and accumulate reputation weight.

### Role

A contextual subdivision (e.g., `STUDENT`, `PROFESSOR`, `VALIDATOR`) mapped to a 32-byte hash. Reputation states are isolated per `(Context, Role)` pair.

### DRIFT Client

Pluggable execution models (e.g., `WeightedGovernanceClient.sol`) deployed via EIP-1167 minimal proxies. These sub-clones pull balances from token ledgers to resolve application-specific actions: voting weights, rate limits, or payout thresholds.

## Design Decisions

### Why not store attestations on-chain?

Storing individual micro-attestations (packet delivery logs, file integrity audits, peer reviews) in EVM storage causes state bloat and prohibitive `SSTORE` costs. DRIFT leaves raw interaction histories in off-chain data availability layers (indexer graphs, IPFS, Arweave). The smart contract layer records only consensus states.

### Why off-chain reputation computation?

EigenTrust and similar algorithms require matrix multiplications across peer-vouched trust networks. Executing these operations in the EVM consumes the full block gas limit. DRIFT delegates computation to the SDK tier, translating large transaction graphs into single-slot on-chain signature verification.

### Why ERC-1155 for reputation tokens?

Tracking participant standing across independent contexts and roles via individual ERC-20 deployments creates gas overhead and interface fragmentation. The EIP-1155 multi-token standard allows a single contract to track distinct `(Context, Role)` configurations via a unified balance mapping.

### Why soulbound tokens?

Reputation derives utility from identity attachment, not transferability. If reputation tokens were transferable, actors could buy high-reputation accounts to hijack governance or subvert trust networks. All transfer functions in `DRIFTToken.sol` are hard-coded to `revert`, making tokens permanently non-transferable.

## Deployments

Contract addresses are stored in `packages/contracts/deployments/{chainId}.json`.

| Network          | Chain ID | Deployment File |
|------------------|----------|-----------------|
| Ethereum Sepolia | 11155111 | [11155111.json](./deployments/11155111.json) |
| Arbitrum Sepolia | 421614   | N/A |

## Repository Navigation

- [`/contracts`](./packages/contracts/) — Foundry project containing core protocol registries, soulbound token factories, context gatekeepers, and governance templates.

- [`/sdk`](./packages/sdk/) — Node.js/TypeScript SDK with data providers, off-chain computation engines, and EIP-712 settlement oracles.

## Prerequisites

- [`NodeJS`](https://nodejs.org/)

- [`Foundry`](https://www.getfoundry.sh/)

## License

Distributed under the MIT License. See `LICENSE` for details.
