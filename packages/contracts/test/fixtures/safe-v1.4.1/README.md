# Safe v1.4.1 runtime bytecode

Runtime code of the canonical Safe v1.4.1 deployments. `DRIFTSafeSettler.t.sol` etches it at the same addresses, so the Tier 2 tests run against the code that is actually deployed, not a recompiled copy. It was fetched with `eth_getCode` from Arbitrum Sepolia on 2026-10-01 and is byte-identical on Sepolia.

| File | Address | keccak256(code) |
|---|---|---|
| Safe.hex | 0x41675C099F32341bf84BFc5382aF534df5C7461a | 0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4 |
| SafeProxyFactory.hex | 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 | 0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317 |
| MultiSend.hex | 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526 | 0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77 |
| CompatibilityFallbackHandler.hex | 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99 | 0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9 |
| SignMessageLib.hex | 0xd53cd0aB83D845Ac265BE939c57F53AD838012c9 | 0x525c754a46b79e05543a59bb61e8de3c9eee0d955a59352409cbe67ea1077528 |

To check a file against a chain:

```sh
cast keccak $(cast code 0x41675C099F32341bf84BFc5382aF534df5C7461a --rpc-url arbitrum_sepolia)
```

The source is github.com/safe-global/safe-smart-account at tag v1.4.1. MultiSend embeds its own address as an immutable, so it only behaves correctly at its canonical address.
