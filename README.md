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

## System Architecture

### Contract Design

```mermaid
graph TB
    subgraph OffChain ["Off-Chain Environment"]
        DATA["Attestation & Data Registries"]:::offchainNode
        SDK["DRIFT SDK<br/>- Reads raw data<br/>- Runs reputation algorithm<br/>- Generates EIP-712 Signatures"]:::offchainNode
    end

    subgraph OnChain ["On-Chain Ecosystem"]
        CORE["DRIFTCore (Registry & Firewall)<br/>- Node & Context Management<br/>- Role Authorization"]:::onchainNode

        TOKEN["DRIFTToken (ERC-1155)<br/>• Soulbound Ledger<br/>- Sole Authority: DRIFTCore"]:::onchainNode

        subgraph Clients ["DRIFT Client Modules (Execution Logic)"]
            BC["Business Client<br/>- Schema & Threshold policies"]:::onchainNode
            WG["Governance Client<br/>- Context-specific voting weights"]:::onchainNode
            CC["Cross-Context Client<br/>- Multi-context aggregation"]:::onchainNode
        end

        subgraph Consumers ["External Integrations"]
            DAO["DAO Tooling<br/>- e.g., Snapshot, Tally"]:::consumerNode
            DEFI["DeFi Protocols<br/>- e.g., Undercollateralized Loans"]:::consumerNode
        end
    end

    %% Flow of Reputation (Write)
    DATA -.-> SDK
    SDK ==>|"1. Submit Signed Payload (settleReputation)"| Clients
    Clients -->|"2. Verify Sig & Request Mint/Slash"| CORE
    CORE -->|"3. Execute State Change"| TOKEN

    %% Flow of Consumption (Read)
    DAO --> WG
    DAO --> CC
    WG -.->|"Reads balance & applies math"| TOKEN
    CC -.->|"Reads balance & applies math"| TOKEN
    DEFI -.->|"Reads balance & assesses risk"| TOKEN

```

### Reputation Lifetime

```mermaid
graph TD
    %% Data Sources (Left)
    subgraph DataSources [External Data Environment]
        A1[Attestation Registries<br/>e.g., EAS, Verax]:::userNode
        %% A2[Web2 Proofs & Oracles<br/>e.g., zkTLS, Chainlink]:::userNode
    end

    %% Off-Chain SDK (Middle)
    subgraph OffChain [Off-Chain Computation SDK]
        B1(Data Aggregator):::offchainNode
        B2{Context-Specific Algorithm}:::offchainNode
        B3(Trusted Settler Signer):::offchainNode

        B1 --> |Reads On-Chain Attestations| B2
        B1 --> |Verifies Zero-Knowledge Proofs| B2
        B2 --> |Calculates Reputation Delta| B3
        B3 --> |Generates EIP-712 Signature| B4[SettleReputation Payload]:::offchainNode
    end

    %% On-Chain DRIFT (Right)
    subgraph OnChain [DRIFT On-Chain Protocol]
        C1[DRIFT Client<br/>e.g., Governance, Rewards]:::onchainNode
        C2[DRIFTCore<br/>Registry & Firewall]:::onchainNode
        C3[(DRIFTToken<br/>ERC-1155 Ledger)]:::onchainNode

        C1 --> |1. Verifies EIP-712 Signature<br/>2. Calls core.reward/slash| C2
        C2 --> |Hashes Context + Role<br/>Mints/Burns Soulbound Tokens| C3
    end

    %% Client Execution (Bottom)
    subgraph Execution [Client Application/Execution]
        D1[User Interaction<br/>e.g., Cast Vote, Claim Reward]:::userNode
        D2[Client Engine<br/>Applies Context Logic & Multipliers]:::onchainNode
        D3[Execute Action<br/>e.g., DAO Execution, Payout]:::onchainNode

        D1 --> C1
        C1 --> |Reads Reputation Power| D2
        D2 --> |Checks Balances| C3
        D2 --> |Thresholds Met| D3
    end

    %% Connections
    A1 -.-> B1
    %% A2 -.-> B1
    B4 ==> |Relayer submits transaction| C1

```


## Implementing a Client Contract

DRIFT is designed to be plug-and-play for DAOs and protocols.
A DAO's `Governor` contract registers a context and inherently receives the `CONTEXT_ADMIN` role.

To initialize a reputation context, a client must define:

- **Context Name:** Human-readable label (Namespacing is secured by hashing the name to prevent squatting).

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

Solidity Contracts:

- [OpenZeppelin v5](https://www.openzeppelin.com/) - access control, upgradeability, ERC standards

EVM:

- [Cancun](https://www.evm.codes/?fork=cancun) - includes support for `ReentrancyGuardTransient` (EIP-1153)

### File Structure

```
DRIFT
├── sdk
│   └── example.js
├── src
│   ├── client
│   │   ├── DRIFTClientFactory.sol
│   │   ├── IDRIFTClientMetadata.sol
│   │   ├── IDRIFTClient.sol
│   │   ├── IDRIFTGovernance.sol
│   │   └── IDRIFTSettler.sol
│   ├── Common.sol
│   ├── core
│   │   ├── DRIFTCore.sol
│   │   ├── DRIFTCoreStorage.sol
│   │   └── IDRIFTCore.sol
│   ├── providers
│   │   ├── EAS.sol
│   │   └── IAttestationProvider.sol
│   ├── templates
│   │   ├── CrossContextGovernance.sol
│   │   ├── DemocraticGovernance.sol    // TODO
│   │   ├── QuadraticGovernance.sol     // TODO
│   │   └── WeightedGovernance.sol
│   └── token
│       ├── DRIFTToken.sol
│       └── IDRIFTToken.sol
└── test
    ├── core
    │   └── DRIFTCore.t.sol
    ├── examples
    │   └── University.t.sol
    ├── mocks
    │   ├── MockAdapter.sol
    │   └── MockEAS.sol
    ├── providers
    │   └── EASAdapter.t.sol
    └── templates
        └── WeightedGovernance.t.sol
```


### Setup

```bash
git clone https://github.com/drift-org/drift
cd drift

# Install Foundry dependencies
forge install

# Install JS dependencies
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

For gas reports:

```bash
forge snapshot --gas-report
```

For coverage:

```bash
forge coverage
```

## License

MIT
