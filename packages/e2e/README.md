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

## Measured gas and fees

```sh
drift-e2e measure --config <cfg>    # local anvil fork of the config's chain; writes e2e-run/gas-measured.json
drift-e2e fees    --config <cfg>    # read-only eth_feeHistory: base-fee percentiles and how often each cap is exceeded
drift-e2e plan    --config <cfg> --measured measurements/gas-sepolia.json
```

`measure` forks the chain at a recent block (with chain id 31337), checks that the URL it sends to is a local anvil, and runs one of every experiment action against the real EAS, schema registry and Safe v1.4.1 contracts:
- the full `Deploy.s.sol` stack, run from the experiment mnemonic;
- two contexts with client clones and configuration;
- a 2-of-3 Safe, a schema, registrations and role assignments;
- attestations, including `multiAttest` with 1, 4 and 12 items;
- a Tier 1 epoch over a 128-leaf tree: challenge, response, bond withdrawal, claims, a proposal and votes;
- a second epoch with an omission challenge that is claimed;
- a one-round Safe settlement.

It records each receipt's `gasUsed`. `measurements/gas-sepolia.json` is the table from Sepolia block 11823917.

With `attestations.batch` > 1, each node's attestations of a round go out in `multiAttest` transactions. Every transaction is priced at its full batch size.

`fund` and `sweep` never send above `gas.maxFeeGwei`. While the base fee is higher, they wait (`--wait-minutes`, default 60) and then give up rather than pay more.

## Deployment key

`Deploy.s.sol` deploys from index 0 of whatever `MNEMONIC` it sees, and in a typical shell `MNEMONIC` is the funded account. The tooling never lets forge inherit it:
- `forgeEnv` replaces `MNEMONIC` with the experiment mnemonic;
- `experimentDeployer` refuses when that mnemonic's deployer isn't the plan's;
- after deploying, the core's admin must be the experiment deployer.

## Budgets

`examples/` holds two experiment shapes, planned from the measured table with a 3 gwei cap, 0.2 gwei priority fee and a 1.2 margin:

| | `sepolia-0.8eth.json` | `sepolia-2.5eth.json` |
|---|---|---|
| nodes | 30 | 50 |
| attestations (per node per round x rounds, batch) | 3 x 6, batch 3 | 3 x 12, batch 3 |
| epochs, Tier 1 / Tier 2 | 24 / 24 | 72 / 72 |
| omission / answered / watcher challenges | 2 / 2 / 2 | 6 / 6 / 6 |
| dead Tier 2 rounds | 2 | 4 |
| claims per epoch | 3 | 5 |
| proposals x voters | 3 x 15 | 6 x 25 |
| required (from empty keys, incl. 0.03 reserve) | 0.628 ETH | 1.914 ETH |
| headroom | 21% | 23% |

## Deployment

`drift-e2e deploy --config <file>` sets the experiment up on the target chain, from the experiment mnemonic only (through the deployment-key guard below), and only after `plan` has written `funding-plan.json` for the same keys:

1. the contract stack (`Deploy.s.sol`);
2. an EAS schema unique to the run: `uint256 score, uint256 drift_<runTag>` (all-uint256, as the engine protocol requires);
3. for Tier 2, a Safe with the configured owners and threshold, created through the canonical Safe v1.4.1 factory at a predictable address, and funded with two settlement bonds;
4. one context per tier with epochs (`drift-e2e.<runTag>.tier1` / `.tier2`): the client, its dispute and response windows and bonds, every node registered and given the member role (the watcher's key too, in the Tier 1 context), and the epoch length last, so the epoch anchor follows every registration.

It writes `deployment.json` (addresses, context UIDs, client addresses, the Safe, the schema UID, the start block for log scans), which the later phases read.

`deploy` can be interrupted at any point and run again. Every step first checks chain state, so a step already done is never sent again; every transaction is signed and saved to `deploy-state.json` before it is broadcast, and on resume a saved transaction is waited for if pending, re-broadcast byte for byte if the network never saw it, or reconciled from chain state if its nonce was used by something else. A stack deployment interrupted inside forge resumes with `forge script --resume`. Re-running a completed deployment sends nothing. `runTag` names the deployment: the same tag resumes it, a new tag starts a fresh one. Settings the client allows only once (windows, epoch length) are checked against the config and refused if they differ.

Experiment config fields used here: `runTag`, `timing` (`epochLengthSeconds`, default 3600; `disputeWindowSeconds` and `responseWindowSeconds`, default 900 each; the epoch must exceed their sum) and `eas` (`address`, `schemaRegistry`, default the canonical Sepolia deployment).

## Run

`drift-e2e run --config <file>` runs the experiment on the real chain against `deployment.json`, and `drift-e2e rehearse` runs the same code on a local anvil first (see RUNBOOK.md for the order of commands).

- Daemons: the Tier 1 settler, one daemon per Tier 2 Safe owner (owner 0 serves the relay; the others write to it over HTTP, signed) and a watcher on the Tier 1 context, as `drift-operator run` child processes with generated configs (keys only in their environment) and the recorder on. Each Safe owner sends from its own hot wallet.
- Members: attestation waves through EAS `multiAttest`, spread over the run; after each epoch finalizes, claims (proof from the operator API, checked against the on-chain root, or the tree from IPFS if the API fails); proposals and votes. They record `client.attest`, `client.claim`, `client.vote` and every transaction's receipt.
- Scenarios, one of each by default: a node challenges its own included pair and the Tier 1 settler answers; a misbehaving settler posts a Tier 1 root omitting the watcher's pair, the watcher challenges, nobody answers and the challenge is claimed (the epoch rolls back and is re-posted); a dead Tier 2 round, with two owners offline until its reveal deadline passes.
- Time: real mode follows the chain; a rehearsal fast-forwards chain time whenever every task is waiting for it.
- Resume: every member transaction is journaled in `run-state.json` (signed and saved before it is broadcast), daemons are stateless, so re-running `run` after a crash continues without duplicates.
- IPFS: real mode uses the node named by `services.ipfsApiUrlEnv`, or starts its own Kubo (repository under `<out>/kubo`, needs `ipfs` on PATH); a rehearsal uses an in-memory stand-in, and serves the EAS GraphQL queries from EAS's logs.
- `plan` also prints the schedule: each tier's boundary-to-final path, its slack per epoch, and the run length.

## Safety

`fund`:
- refuses to run on the wrong chain, while the funder has pending transactions, when the base fee is above the cap, or when it would leave the funder below the reserve;
- refuses a plan whose addresses don't match the ones the mnemonic derives now;
- sends only the shortfall to each key, so running it again sends nothing;
- journals every transfer to `e2e-run/funding-journal.jsonl`.

Amounts in the config are decimal strings, so no ETH value passes through floating point.

## Analysis

`drift-e2e analyze <dir...> [--out <dir>]` turns the operator's recorder logs (one JSONL file per daemon process, `recorder.dir` in the operator config) into the evaluation's tables. It reads every `*.jsonl` under the given directories, so the logs of every daemon in a run, or of several runs, can be analysed together.

- **Validation.** Every line is checked with the operator's `validateEvent`. Invalid lines, gaps or repeats in a file's `seq`, and transactions sent without a recorded receipt are listed in `quality.csv` and `quality.tex`; nothing is dropped silently.
- **One definition.** Latencies come from the operator's `LATENCIES`, the same definitions the live `/metrics` histograms use.
- **Merging processes.** The owners of one Tier 2 Safe name their contexts differently; contexts that recorded the same proposal are one group, labelled by their sorted names. A milestone seen by several processes (two owners recording the same publication) is kept once, at its earliest observation, and a pair latency uses the earliest start and the earliest end over all processes.
- **Percentiles.** Nearest rank: the value at rank ceil(p/100 · n) of the sorted sample. The median is the lower middle value for even n.
- **Reverted transactions** (for example two owners executing the same settlement at once) are counted apart from the gas statistics of their action, and their fees are included in the totals.
- **Determinism.** The same logs give byte-identical files: rows are sorted, numbers have fixed digits, and no output records when it was generated.

| File | Content |
|---|---|
| `latency.csv`, `latency.tex` | per latency and tier: n, median, p90, p99, min, max (seconds) |
| `latency-samples.csv` | every sample, for pgfplots box plots and histograms |
| `gas.csv`, `gas.tex` | gas per action and tier from receipts; reverted transactions; ETH paid |
| `cost-per-epoch.csv`, `cost.tex` | ETH per settled epoch and per tier |
| `tier2-rounds.csv`, `tier2-rounds-per-epoch.csv`, `tier2-steps.csv`, `tier2.tex` | rounds, outcomes, and the commit, reveal, publish, sign and execute steps |
| `disputes.csv`, `watcher.csv`, `disputes.tex` | challenge detection and response, watcher detection |
| `timeline.csv` | one row per epoch: t_E, O1 wait, snapshot, compute, settlement, finalization, bond, rounds, cost |
| `quality.csv`, `quality.tex`, `inputs.csv` | data quality |
| `summary.json` | everything above, plus the method notes |

The LaTeX files are `tabular` environments in booktabs style with numbers grouped as `125{,}375`; `\input` them inside a `table` float.

**Indexer check (opt-in).** With `--indexer-rpc-env <VAR> --eas <address> --schema <uid> [--from-block <n>]`, each snapshot's attestation count (what the indexer returned for the schema at t_E) is compared with the count rebuilt from EAS's own `Attested` and `Revoked` logs up to t_E (`indexer.csv`, `indexer.tex`). This turns the assumption that the indexer is fresh into a measured fact. All contexts are assumed to use the given schema.
