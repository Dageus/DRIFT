# DRIFT live-network evaluation (`@drift-network/e2e`)

Tooling for running DRIFT on a public testnet. Phase 1 is funding: every experiment key derives from one mnemonic, a plan computes what each key needs from the actions it will perform, and the funder tops keys up to exactly that. A sweep returns the leftovers.

## Keys

All experiment keys are `m/44'/60'/0'/0/<index>` from one experiment mnemonic, the path Foundry's `vm.deriveKey(mnemonic, i)` uses, at fixed indices:

| Index | Role | Pays for |
|---|---|---|
| 0 | deployer and context admin | deployment, contexts, clients, configuration, role assignment, schema, Safe creation and its bond capital |
| 1 | Tier 1 settler | `postEpochRoot` and its bonds |
| 2 | Tier 1 hot wallet | challenge responses, bond withdrawals |
| 3 | Tier 2 hot wallet | executing the Safe settlement, bond withdrawals |
| 4 | watcher hot wallet | its registration, challenges and claims |
| 10+ | Tier 2 Safe owners | nothing (off-chain signatures only) |
| 1000+ | member nodes | registration, attestations, claims, proposals, votes, node challenges |

A key's index never depends on the experiment's size. The funder is a separate key, named by the config (`funder.privateKeyEnv`, or `funder.mnemonicEnv` + `index`).

## Workflow

```sh
drift-e2e keys new                                   # once; store the mnemonic, it is not saved
export E2E_MNEMONIC='...' SEPOLIA_RPC_URL='...' MNEMONIC='...'   # names come from the config
drift-e2e plan   --config experiment.json            # writes e2e-run/funding-plan.json, checks the funder can cover it
drift-e2e fund   --config experiment.json            # dry run: what would be sent
drift-e2e fund   --config experiment.json --yes      # send
drift-e2e status --config experiment.json
drift-e2e sweep  --config experiment.json --yes      # after the experiment
```

Each key's target is `gas x maxFee x margin + bond capital`, plus one transfer so its leftovers can be swept. `plan` marks every action whose gas is still an estimate. Run `measure` on a Sepolia fork (Phase 2) before funding for real.

## Safety

`fund`:
- refuses to run on the wrong chain, while the funder has pending transactions, when the base fee is above the cap, or when it would leave the funder below the reserve;
- refuses a plan whose addresses don't match the ones the mnemonic derives now;
- sends only the shortfall to each key, so running it again sends nothing;
- journals every transfer to `e2e-run/funding-journal.jsonl`.

Amounts in the config are decimal strings, so no ETH value passes through floating point.
