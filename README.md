<h1 align="center">DRIFT</h1>

<h3 align="center"> Decentralized Reputation Infrastructure for Trust</h3>

<div align="center">

![Solidity](https://img.shields.io/badge/Solidity-0.8.28-purple?style=flat-square&logo=solidity&logoColor=white&labelColor=%23DBA507&color=%237B1FA2)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Ethereum](https://img.shields.io/badge/Ethereum-3C3C3D?logo=ethereum&logoColor=white)
![Foundry](https://img.shields.io/badge/Built%20with-Foundry-orange?style=flat-square)

</div>

<br/>

## Introduction

The DRIFT protocol aims to work atop an existing Attestation Layer
(be it [EAS](https://attest.org/), [Verax](https://docs.ver.ax/verax-documentation), or a custom provider)
and provides context-scoped, privacy-preserving reputation infrastructure for Web3 and Web2 systems.

DRIFT won't directly store attestations (since there are plenty of systems that
excel at it), but instead will define trust boundaries within which those claims
are meaningful, and provides the on-chain primitives and off-chain tooling to
aggregate them into reputation scores.

DRIFT is designed around three principles:

- **Context isolation** — reputation is always scoped to a context. A node's score in a DePIN network is independent of its score in a DAO. Neither leaks into the other.

- **Attestation-source agnosticism** — DRIFT does not depend on any specific attestation provider. Any system that implements `IAttestationProvider` can serve as a data source.

- **Off-chain computation, on-chain trust** — reputation scores are computed off-chain (via The Graph and decentralized compute networks) and verified on-chain only when needed, keeping gas costs minimal.

## Core Concepts

### Context

A **context** is a namespaced reputation domain registered by a client (a DApp, a DAO, a DePIN network, etc.).
Each context defines:

- Which attestation **schemas** it accepts

- Which **adapter** verifies each schema

- A set of **admins** (via OZ AccessControl) who can manage the context

Contexts are globally unique by name. The UID is derived as `keccak256(name)`,
making it deterministic and human-derivable off-chain.

### Schema

A schema defines the structure of an attestation's data payload.
DRIFT does not store schema definitions — those live in the chosen attestation provider (e.g. EAS's `SchemaRegistry`).

DRIFT only stores whether a schema is **accepted within a given context**, referenced by its UID.

### Adapter

An **adapter** is a contract implementing `IAttestationProvider`.
It bridges DRIFT to a specific attestation backend, translating provider-specific
verification logic into DRIFT's `isValid()` interface.

DRIFT ships with a built-in **EAS adapter**.

### Node

Any entity (a user wallet, an off-chain server, or a sub-DAO) that registers within a Context to earn reputation.

### Role

A specific subset within a Context (e.g., `STUDENT` or `MODERATOR`).
Reputation is mathematically scoped to a specific Context + Role pair.

### DRIFT Client / Template

The execution layer (e.g., `WeightedGovernanceClient`).
These are modular, isolated smart contracts plugged into the Core. They define how reputation is used within a specific Context.

## Design Decisions

**Why not store attestations on-chain?**

TODO

**Why off-chain reputation computation?**

TODO

**Why ERC-1155 for reputation tokens?**

TODO

**Why soulbound tokens?**

TODO

## Repository Navigation

This is a monorepo containing both the on-chain smart contracts and the off-chain TypeScript SDK.

- [`/contracts`](./contracts/README.md) - The Foundry project containing the core protocol, ERC-1155 tokens, and client templates.

- [`/sdk`](./sdk/README.md) - The Node.js/TypeScript SDK for fetching attestations, running reputation algorithms, and generating EIP-712 signatures.


## License

MIT
