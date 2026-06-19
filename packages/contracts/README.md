# DRIFT Smart Contracts

This repository contains the core smart contract primitives for DRIFT (Decentralized Reputation Infrastructure for Trust). The codebase isolates structural participant verification, identity-bound credential ledgers, and pluggable governance execution templates.

The architecture deploys via EIP-1167 minimal proxy factories to prevent on-chain state bloat and reduce deployment gas costs for context creators.

## Core Architecture Components

**DRIFTCore.sol** manages organizational context spaces, handles schema links, and acts as the gatekeeper ledger for active node states.

**DRIFTToken.sol** is an EIP-1155 multi-token registry tracking identity-bound attributes. Transfers are explicitly short-circuited to guarantee non-transferable credentials.

**WeightedGovernanceClient.sol** consumes off-chain computational assertions (e.g., EigenTrust) by verifying EIP-712 signatures from a trusted settler. It handles proposal configurations and translates token ownership into voting power coefficients.

## Implementing a Client Contract

DRIFT is designed for DAOs and protocols. A DAO's Governor contract registers a context and receives the `CONTEXT_ADMIN` role.

To initialize a reputation context, a client defines:

**Context Name:** A human-readable label. Namespacing is secured by hashing the name to prevent squatting.

Once registered, context administrators configure trust boundaries by adding schemas:

**Accepted Schemas:** The specific UIDs of schemas allowed in the context.

**Provider Adapters:** The `IAttestationProvider` contract addresses (e.g., `EASAdapter`) that DRIFT uses to route and verify those schema UIDs.

## System Architecture

```mermaid
sequenceDiagram
    autonumber
    actor User as Participant Node
    participant Front as DApp Frontend (DriftClient SDK)
    participant EAS as EAS Subgraph (GraphQL Data)
    participant Settler as DriftSettler (Off-Chain Engine)
    participant Core as DRIFTCore Contract (Registry)
    participant Gov as Governance Client Clone
    participant Token as DRIFTToken Contract (Ledger)

    User->>Front: Click "Settle My Score"
    Front->>Front: Extract active account, role & contextUID
    Front->>Settler: HTTP POST /api/v1/settle<br/>{ userAddress, role, contextUID }
    activate Settler
    Settler->>EAS: GraphQL Query (fetchUserRecords / fetchRecordsByAttester)
    EAS-->>Settler: Return raw hex AttestationRecord[]

    Settler->>Settler: Execute EigenTrustEngine matrix math
    Settler->>Settler: Sign calculation payload using EIP-712 Domain Separator
    Settler-->>Front: Return JSON JSON { score, epoch, signature }
    deactivate Settler

    Front->>User: Prompt MetaMask Signature Call
    User->>Front: Approve & sign transaction gas fees
    Front->>Gov: settleReputation(node, role, score, epoch, signature)
    activate Gov

    Gov->>Gov: Replay Check: require(!consumedDigests[digest])
    Gov->>Gov: Cryptographic Recovery: ECDSA.recover(digest, sig)
    Gov->>Gov: Assert Signer: require(recovered == trustedSettler)

    Gov->>Core: reward(contextUID, role, node, score)
    activate Core
    Core->>Core: Assert Onboarding Status:<br/>nodeStatus != NONE && nodeStatus != BANNED
    Core->>Token: rewardReputation(node, tokenId, score)
    activate Token
    Token-->>Core: Success (State modified)
    deactivate Token
    Core-->>Gov: Success
    deactivate Core

    Gov-->>Front: Emit ReputationSettled(contextUID, node, role, score, epoch)
    deactivate Gov
    Front-->>User: UI Update: Display Settlement Success
```

## Development

### Prerequisites

Testing:

- [Foundry](https://www.getfoundry.sh/) - testing, fuzzing, deploying

Solidity Contracts:

- [OpenZeppelin v5](https://www.openzeppelin.com/) - access control, upgradeability, ERC standards

EVM:

- [Cancun](https://www.evm.codes/?fork=cancun) - includes support for `ReentrancyGuardTransient` (EIP-1153)

### Setup

```bash
git clone https://github.com/drift-org/DRIFT
cd DRIFT

# Install Foundry dependencies
forge install
```

**Foundry submodules**:

```bash
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts
forge install OpenZeppelin/openzeppelin-contracts-upgradeable
```

### Execution Commands

**Compile Contracts**:

```bash
forge build
```

**Run unit tests**:

```bash
forge test -vv
```

**Generate Gas analysis**:

```bash
forge snapshot --gas-report
```

### Mainnet/Testnet Simulation

```bash
# Simulate execution directly on Avalanche Fuji
forge test --rpc-url https://api.avax-test.network/ext/bc/C/rpc --match-path test/providers/EASAdapter.t.sol
```

**Deploying the contract**:

```bash
export RPC_URL="https://ethereum-sepolia-rpc.publicnode.com" # for example
export PRIVATE_KEY="..."
export ETHERSCAN_API_KEY="..."
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  -vvvv
```

You can also do:

```bash
export PRIVATE_KEY="..."
export ETHERSCAN_API_KEY="..."
forge script script/Deploy.s.sol:DeployScript \
  network_name \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  -vvvv
```

Check the `network_name` options in [`foundry.toml`](./foundry.toml).

**Dry deployment**:

```bash
forge script script/Deploy.s.sol:DeployScript --rpc-url $RPC_URL
```

**Local deployment**:

```bash
export RPC_URL="..."
anvil --fork-url $RPC_URL --port 8545

forge script script/Deploy.s.sol:DeployScript --rpc-url http://127.0.0.1:8545 --broadcast
```

Here are some useful URLs:

- Arbitrum One: `https://arb1.arbitrum.io/rpc`

- Arbitrum Nova: `https://nova.arbitrum.io/rpc`

- Optimism: `https://mainnet.optimism.io/`

- Base: `https://1rpc.io/base`

## Local Testing

**Simulating L1 chain**:

```bash
anvil --block-time 12 --gas-limit 30000000
```

**Simulating L2 chain**:

```bash
anvil --port 8546 --block-time 0.25 --gas-price 100000000
```
