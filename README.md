<h1 align="center">DRIFT</h1>

<h3 align="center"> Decentralized Reputation Infrastructure for Trust</h3>

<div align="center">

![Solidity](https://img.shields.io/badge/Solidity-0.8.28-purple?style=flat-square&logo=solidity&logoColor=white&labelColor=%23DBA507&color=%237B1FA2)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Ethereum](https://img.shields.io/badge/Ethereum-3C3C3D?logo=ethereum&logoColor=white)
![Foundry](https://img.shields.io/badge/Built%20with-Foundry-orange?style=flat-square)
![Hardhat](https://img.shields.io/badge/Built%20with-Hardhat-yellow?style=flat-square)

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

- The **minimum stake** required for nodes to participate

- A set of **context admins** (via OZ AccessControl) who can manage the context

Contexts are globally unique by name. The UID is derived as `keccak256(name)`,
making it deterministic and human-derivable off-chain.

### Schema

A schema defines the structure of an attestation's data payload.
DRIFT does not store schema definitions — those live in the chosen attestation provider
(e.g. EAS's `SchemaRegistry`).

DRIFT only stores whether a schema is **accepted within a given context**, referenced by its UID.


### Adapter

An **adapter** is a contract implementing `IAttestationProvider`.
It bridges DRIFT to a specific attestation backend, translating provider-specific
verification logic into DRIFT's `isValid()` interface.

DRIFT ships with a built-in **EAS adapter**.


### Node Registration

Any address may join a context by calling `registerNode(contextUID)` and providing the required stake.
Registered nodes may attest about other registered nodes in EAS.
Attestations from unregistered addresses are ignored by DRIFT's off-chain indexer.

Deregistration is a **two-step process**:

- `requestDeregister()` starts an unbonding period (7 days by default)

- `executeDeregister()` releases the stake.

This prevents a node from submitting malicious attestations and immediately exiting
before any slashing mechanism can act.


### Trust Verification

`verifyAttestation()` is DRIFT's core on-chain primitive.
Given a context, schema, attestation UID, subject, and attester, it checks:

1. The context is active

2. The schema is accepted in this context

3. The attester is a registered node

4. The subject is a registered node

5. The registered adapter validates the attestation UID

## Implementing a Client Contract

DRIFT is designed to be plug-and-play for DAOs and protocols.
A DAO's `Governor` contract registers a context and inherently receives the `CONTEXT_ADMIN` role.

The Governor can securely delegate operational control
by granting the `SCHEMA_MANAGER` role to a security multi-sig,
allowing agile schema updates without requiring a full DAO vote for every change.

To initialize a reputation context, a client must define:

- **Context Name:** Human-readable label (Namespacing is secured by hashing the name with the deployer's address to prevent squatting).

- **Minimum Stake & Token:** The financial requirements to join the context as a node (use `address(0)` for native ETH).

Once registered, the context administrators configure the trust boundaries by adding schemas:

- **Accepted Schemas:** The specific UIDs of the schemas allowed in the context.

- **Provider Adapters:** The specific `IAttestationProvider` contract addresses (e.g., `EASAdapter`) that DRIFT will use to route and verify those specific schema UIDs.

## Deployments

| Network          | DRIFTCore | EASAdapter |
|------------------|-----------|------------|
| Ethereum Sepolia | —         | —          |
| Arbitrum Sepolia | —         | —          |
| Avalanche Fuji   | —         | —          |

Addresses will be populated on first deployment.

## Development

### Prerequisites

Testing:

- [Foundry](https://www.getfoundry.sh/) - testing, fuzzying

- [Hardhat](https://hardhat.org/) - deployment scripts, dApp development

Solidity Contracts:

- [OpenZeppelin v5](https://www.openzeppelin.com/) - access control, upgradeability, ERC standards

EVM:

- [Cancun](https://www.evm.codes/?fork=cancun) - includes support for `ReentrancyGuardTransient` (EIP-1153)

### File Structure

```
drift/
├── src/
│   ├── Common.sol                      # Shared types (DRIFTTypes)
│   ├── interfaces/
│   │   ├── IDRIFTCore.sol              # Core interface
│   │   ├── IAttestationProvider.sol    # Adapter interface
│   │   └── IDRIFTClient.sol            # Client interface (WIP)
│   ├── core/
│   │   ├── DRIFTCoreStorage.sol        # Isolated storage layout
│   │   └── DRIFTCore.sol               # Central registry (UUPS upgradeable)
│   ├── adapters/
│   │   └── EASAttestationAdapter.sol   # EAS implementation of IAttestationProvider
│   └── client/
│       └── DRIFTClient.sol             # Reference client implementation (WIP)
├── sdk/                                # Future SDK for Web2 use
└── test/
    └── core/
        └── DRIFTCore.t.sol             # Foundry test suite
```


### Setup

```bash
git clone https://github.com/drift-org/drift
cd drift

# Install Foundry dependencies
forge install

# Install Hardhat and JS dependencies
npm install  # or yarn install
```

### Build

```bash
forge build
```

### Test

```bash
forge test -vv
```

For gas snapshots:

```bash
forge snapshot
```

For coverage:

```bash
forge coverage
```

## License

DRIFT's future license should go here (probably MIT)
