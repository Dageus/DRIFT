# DRIFT engines (Rust)

Phi_c behind a gRPC boundary, so a settler can compute an epoch in process, on a remote server, in a signing committee, or in the RISC Zero zkVM. `SPEC.md` defines the protocol. The `.proto` file is `../protos/drift/engine/v1/engine.proto`, which the TypeScript client loads as well.

```
core/            drift-engine-core: EngineInput/EngineJournal ABI types, canonical digest,
                 EigenTrust port, OpenZeppelin StandardMerkleTree root
server/          drift-engine: tonic gRPC server, evidence modes none | signed | risc0
risc0/methods/   builds the zkVM guest and exposes DRIFT_ENGINE_GUEST_ELF / _ID
risc0/methods/guest/   reads the input, canonicalizes, runs core, commits the journal
vectors/         cross-language test vectors written by the TypeScript reference
```

## Build and test

```sh
nix develop            # cargo, rustc, protoc
cargo test             # core against vectors/
cargo build            # target/debug/drift-engine
```

The SDK's `engine-grpc.test.ts` starts `target/debug/drift-engine` itself and is skipped when the binary is missing.

## Run

```sh
drift-engine --listen 127.0.0.1:50051                       # Tier 1, no evidence
DRIFT_ENGINE_SIGNING_KEY=0x... drift-engine --evidence signed  # committee member (Tier 2)
```

From TypeScript:

```ts
import { GrpcEpochEngine, CommitteeEpochEngine } from '@drift-network/sdk/engines/remote';

const engine = new GrpcEpochEngine({ endpoint: '127.0.0.1:50051', evidence: 'signed', signers: [operator] });
const { entries, merkleRoot, evidence } = await engine.computeEpoch(input);
await settler.buildAndSignEpochRoot(client, contextUID, epoch, entries, upload); // same root
```

## Tier 3 (RISC Zero)

The default workspace members build with a stock toolchain. The `risc0` feature also compiles the zkVM guest, which needs RISC Zero's Rust toolchain (rustc 1.88 with the `riscv32im-risc0-zkvm-elf` std). The `risc0` shell supplies it from Nix. `risc0-build` only finds toolchains through rzup's directory layout, so the shell builds that layout in `.risc0-home/` and points it at the Nix store, with no `rzup install` needed.

```sh
nix develop .#risc0
cargo build --release -p drift-engine-server --features risc0
RISC0_DEV_MODE=1 target/release/drift-engine --evidence risc0   # executor only, fake receipt
target/release/drift-engine --evidence risc0                    # real succinct proof (slow)
```

The guest is its own Cargo workspace with its own `Cargo.lock`, which is resolved for rustc 1.88. After you change guest dependencies, regenerate it with the guest toolchain:

```sh
cd risc0/methods/guest
PATH=../../../.risc0-home/toolchains/v1.88.0-rust-x86_64-unknown-linux-gnu/bin:$PATH \
  CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile
```

`RISC0_SKIP_BUILD=1` type-checks the host without building the guest. The embedded ELF is then empty.

In the SDK, `DRIFT_ENGINE_RISC0=1 RISC0_DEV_MODE=1 npm test -- engine-grpc` runs the zkVM case. It needs the `risc0` debug build at `target/debug/drift-engine`.
