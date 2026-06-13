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

The DRIFT protocol works atop existing attestation layers (such as [EAS](https://attest.org/) or [Verax](https://docs.ver.ax/verax-documentation)) to provide context-scoped, privacy-preserving reputation infrastructure for Web3 and Web2 networks.

DRIFT does not directly store raw peer attestations. Instead, it defines strict cryptographic trust boundaries within which those external claims are mathematically meaningful. It supplies the immutable on-chain primitives and modular off-chain tooling required to aggregate records into verifiable, sybil-resistant reputation scores.

DRIFT is engineered around three fundamental pillars:

- **Context Isolation** — Reputation is strictly scoped to a unique administrative domain. A node's performance score in a P2P DePIN storage network is isolated from its voting score inside a governance DAO, preventing cross-domain correlation leaks.

- **Attestation-Source Agnosticism** — The core ledger does not depend on a rigid attestation primitive. Any decentralized identity or credential registry that implements the unified `IAttestationProvider` interface can be bound directly into a context as an authorized data stream.

- **Off-Chain Computation, On-Chain Trust** — Heavy graph computations (such as multiplication loops across trusted peer matrices via EigenTrust) run entirely off-chain inside edge runtimes. Validated outputs are committed to the execution chain using low-gas cryptographic proofs (EIP-712 signatures or Zero-Knowledge proofs) only during active mutations.

---

## Core Concepts

### Context

A **context** is a unique, namespaced reputation domain registered permissionlessly by a client framework (a DApp, DAO, or network). Each context exposes an anti-spam native commitment barrier (`0.01 ether`) and explicitly dictates its own verification profile:

- Which external attestation **schemas** it accepts.

- Which verification **adapters** evaluate each schema.

- A set of **administrators** (via OpenZeppelin AccessControl) who manage local configurations.

Context identifiers (`contextUID`) are globally unique and derived deterministically via `keccak256(abi.encodePacked(name))`.

### Schema

A schema dictates the exact data fields contained within an identity claim. DRIFT does not manage global schema validation registries—those are left to the specialized attestation infrastructure (e.g., the EAS `SchemaRegistry`). DRIFT simply acts as a local firewall, storing whether a global `schemaUID` is white-listed within a specific context.

### Adapter

An **adapter** is an on-chain contract implementing the `IAttestationProvider` interface. It acts as a translation layer between DRIFT's core registry and individual validation networks, parsing multi-struct properties into a clean `isValid()` Boolean response. DRIFT ships with a natively integrated, gas-optimized **EAS Adapter**.

### Node

Any unique cryptographic identity (a user wallet, hardware device, or smart contract) that registers within a Context to participate and accumulate reputation weight.

### Role

A contextual subdivision (e.g., `STUDENT`, `PROFESSOR`, or `VALIDATOR`) mapped using a 32-byte hash. Dynamic reputation states are mathematically isolated per Context + Role pair.

### DRIFT Client / Template

Pluggable execution models (e.g., `WeightedGovernanceClient.sol`) deployed via deterministic minimal proxies (EIP-1167). These sub-clones pull balances directly from the token ledgers to resolve application-specific actions, such as voting weights, rate limits, or payout thresholds.

---

## Design Decisions

### Why not store attestations on-chain?

Storing thousands of individual micro-attestations (e.g., packet delivery logs, file integrity audits, peer reviews) inside on-chain EVM storage channels causes severe **state bloat** and financially prohibitive operation costs due to the high gas penalties of the `SSTORE` opcode. DRIFT leaves raw interaction histories where they scale best—in decentralized off-chain data availability layers (such as Indexer graphs, IPFS, or Arweave via EAS). The smart contract layer is treated as an immutable ledger solely for consensus states, keeping the blockchain footprint lightweight.

### Why off-chain reputation computation?

Advanced trust graph evaluation algorithms (such as **EigenTrust**) require complex matrix multiplications, looping through cascading peer-vouched trust networks to isolate and neutralize sybil account clusters. Running these multi-layer floating-point or big-integer matrix operations directly inside the Ethereum Virtual Machine (EVM) will instantly consume a block's full gas limit and trigger execution failures. DRIFT delegates heavy computation to the SDK/Compute edge tier, translating large transaction graphs into cheap, single-slot on-chain signature verification operations.

### Why ERC-1155 for reputation tokens?

Reputation is inherently multi-dimensional. Tracking a participant’s standing across dozens of independent contexts and sub-roles using individual ERC-20 contract deployments creates extreme gas overhead and a fragmented developer interface. The **EIP-1155 Multi-Token Standard** allows a single core contract registry to track an infinite array of distinct Context + Role configurations using a unified, gas-efficient balance mapping table.

### Why soulbound tokens?

Financial assets derive utility from transferability; reputation derives utility from **unconditional identity attachment**. If reputation tokens could be transferred or traded on secondary open markets, malicious actors could simply buy high-reputation accounts to hijack governance structures or subvert peer-to-peer trust networks. To maintain complete cryptographic alignment with a node's actual behavior, all token transfer channels inside `DRIFTToken.sol` are hard-coded to unconditionally `revert`, making them permanently **Soulbound** to the receiving address.

---

## Deployments

Contract addresses are stored in `packages/contracts/deployments/{chainId}.json`.

| Network          | Chain ID | Deployment File |
|------------------|----------|-----------------|
| Ethereum Sepolia | 11155111 | [11155111.json](packages/contracts/deployments/11155111.json) |
| Arbitrum Sepolia | 421614   | N/A |

---

## Repository Navigation

This repository is organized as an integrated monorepo separating smart contract settlement frameworks from application runtime kits:

- [`/contracts`](./contracts/README.md) — The Foundry project containing core protocol registries, soulbound token factories, context gatekeepers, and governance template modules.

- [`/sdk`](./sdk/README.md) — The Node.js/TypeScript SDK housing data providers, custom error decoders, off-chain computation engines (EigenTrust), and EIP-712 settlement oracles.

## License

Distributed under the MIT License. See `LICENSE` for more information.
