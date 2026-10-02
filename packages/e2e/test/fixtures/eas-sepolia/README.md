# EAS on Sepolia, runtime bytecode

Runtime code of the canonical Sepolia EAS deployment. `deploy-anvil.test.ts` etches it at the same addresses on a plain anvil, so the deployment test runs against the deployed code without a fork. Fetched with `eth_getCode` on 2026-10-02 from two independent RPCs (publicnode and Tenderly), byte-identical.

| File | Address | keccak256(code) |
|---|---|---|
| EAS.hex | 0xC2679fBD37d54388Ce493F1DB75320D236e1815e | 0x715b6e99a20024d97deb2a20796b6e4b6529afc146856036b382f358f31a3fa5 |
| SchemaRegistry.hex | 0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0 | 0x83414e120b375c7e50b483fc73b385e8bc3ea37565754160bd06d662d949513f |

EAS embeds the schema registry's address as an immutable, so it only works next to the registry at its canonical address. Its EIP-712 domain is recomputed for the local chain id.
