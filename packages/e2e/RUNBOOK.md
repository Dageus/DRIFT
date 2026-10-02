# Sepolia run: runbook

The real run, in order. Every command runs inside the dev shell from `packages/e2e`, after `npm run build` at the repository root:

```sh
nix develop ~/thesis/DRIFT          # node, forge, anvil
nix shell nixpkgs#kubo              # ipfs, for the run's own IPFS node (step 7)
```

Config: `examples/sepolia-2.5eth.json` (copy it and edit `runTag` per attempt). It runs 50 nodes, 40 epochs per tier with both tiers side by side, 30-minute epochs, 10-minute dispute and response windows, and one of each adversarial scenario. With the measured gas at a 3 gwei cap and a 1.2 margin, `plan` asks for 1.68 ETH; the rehearsal used 1.30 ETH of gas when priced at the cap.

## Environment

| Variable | Holds |
|---|---|
| `SEPOLIA_RPC_URL` | a Sepolia RPC endpoint (a provider key is better than a public one for a 20-hour run) |
| `E2E_MNEMONIC` | the experiment mnemonic, from `drift-e2e keys new`; store it, it is not saved |
| `MNEMONIC` | your funded account (the funder, index 0), never an experiment key |
| `IPFS_API_URL`, `IPFS_GATEWAY_URL` | optional: an existing Kubo node; unset, `run` starts its own (step 7) |

## Steps

| # | Command | Takes | Check |
|---|---|---|---|
| 1 | `drift-e2e keys new` | seconds | store the mnemonic, export it as `E2E_MNEMONIC` |
| 2 | `drift-e2e fees --config <cfg>` | seconds | the 3 gwei cap is rarely exceeded (p99 well below it) |
| 3 | `drift-e2e plan --config <cfg> --measured measurements/gas-sepolia.json` | seconds | "the funder can cover this plan"; no schedule WARNING |
| 4 | `drift-e2e rehearse --config <cfg> --measured measurements/gas-sepolia.json` | about 17 min | finishes all epochs and scenarios; data quality 0 issues; every role's gas below its plan and "lowest key left" well above 0% |
| 5 | `drift-e2e fund --config <cfg>`, then again with `--yes` | about 5 min | dry run first; the second `fund --yes` must say "nothing to send" |
| 6 | `drift-e2e deploy --config <cfg>` | about 15-25 min (about 230 transactions) | writes `e2e-run/deployment.json` |
| 7 | `drift-e2e run --config <cfg>` | about 21 h | see "What to watch" |
| 8 | `drift-e2e analyze e2e-run/events --out e2e-run/analysis --indexer-rpc-env SEPOLIA_RPC_URL --eas <eas> --schema <schemaUID> --from-block <startBlock>` | a minute | data quality 0 issues; indexer check 0 mismatches (the values are in `deployment.json`) |
| 9 | `drift-e2e sweep --config <cfg>`, then with `--yes` | about 5 min | returns every key's balance to the funder |

`--out <dir>` (default `./e2e-run`) must be the same directory for steps 3 to 9. Keep it: it holds the plan, the deployment, the run state, the event logs and the Kubo repository.

The rehearsal runs on a local anvil with Sepolia's EAS, schema registry and Safe v1.4.1 code at their real addresses, time fast-forwarded, every key starting at exactly its planned balance; nothing reaches Sepolia (chain id 31337). `--fork` runs it on a fork of Sepolia instead, which is faithful to Sepolia's state but fetches every storage slot the run touches from the RPC: about 6 minutes per epoch, so hours for the full shape.

## IPFS (Kubo)

The daemons upload and pin each epoch's tree to IPFS. Members fetch the trees through the gateway when the operator API cannot serve a proof. With `IPFS_API_URL` unset, `run` starts its own Kubo node and stops it again when the run ends:

- repository: `e2e-run/kubo`, created on the first run;
- RPC: `127.0.0.1:18710`; gateway: `127.0.0.1:18711`; swarm: port 18712, the only port open beyond loopback;
- log: `e2e-run/kubo/daemon.log`.

`ipfs` must be on PATH (`nix shell nixpkgs#kubo`). To use a node you already run, export `IPFS_API_URL` and `IPFS_GATEWAY_URL`. The trees outlive the run in the repository. The rehearsal does not use Kubo: it uses an in-memory stand-in.

## What to watch during the run

- The run's own log: one line per epoch per tier when it finalizes, and one per scenario.
- Daemon status: `curl -s 127.0.0.1:18700/status | jq` (Tier 1 settler), `:18701` (Tier 2 owner 0, also the relay), `:18702` (watcher). `nextAction` says what each one waits for; `alerts` and `lastError` should stay empty, except the scenarios' expected ones (an unanswerable challenge, a dead round).
- Daemon logs: `e2e-run/daemons/<name>/operator.log`.
- Each tier should finalize one epoch about every 30 minutes. Tier 2 has about a minute of slack per epoch; if it falls behind, latencies grow but nothing breaks.
- Balances: `drift-e2e status --config <cfg>` at any time.

The run stops itself with a diagnosis (each daemon's `nextAction` or `lastError`) if a tier makes no progress for 3 hours.

## Resume

Run the same `run` command again, with the same `--out`. Daemons are stateless (chain plus their tree stores and the relay under `e2e-run/`), the member workload is journaled in `e2e-run/run-state.json`, and every member transaction is signed and saved before it is broadcast, so a resumed run never sends a transaction twice. The same holds for `deploy`.

Fees above the cap: senders wait instead of paying more (up to 6 hours per transaction in `run`, `--wait-minutes` for the others). A transaction that sits in the mempool under a later fee spike is waited for, not replaced.

## After the run

- `analyze` writes the tables (CSV for pgfplots, LaTeX) and `summary.json`; regenerate them from the logs at any time.
- Sweep (step 9) only after the last bonds were withdrawn: `run` waits for that before it exits.
- Then stop the IPFS node if you ran your own (the one `run` starts stops with it). The trees stay in `e2e-run/kubo` and can be served again later with `IPFS_PATH=e2e-run/kubo ipfs daemon`.
