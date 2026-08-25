#!/usr/bin/env bash
# Regenerates the gas-benchmark CSVs the Evaluation chapter tables are drawn from
# (CLAUDE.md Phase 3, items 3 and 6). Run from packages/contracts/.
#
# Source of truth is `snapshots/*.json` — the per-operation gas costs recorded via
# `vm.startSnapshotGas`/`stopSnapshotGas`. Deliberately NOT `.gas-snapshot` (from
# `forge snapshot`), which records whole-test-function totals (proof construction,
# signing, and the postEpochRoot call folded in with the operation under test) and
# is a CI regression guard, not a per-operation cost figure.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/4] Running full test suite to refresh snapshots/*.json ..."
forge test >/dev/null

OUT_DIR="measurements"
mkdir -p "$OUT_DIR"
COMMIT="$(git rev-parse --short HEAD)"
DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

GAS_CSV="$OUT_DIR/gas-benchmarks.csv"
echo "[2/4] Writing $GAS_CSV ..."
{
  echo "category,operation,gas,commit,generated_at"
  for f in snapshots/*.json; do
    suite=$(basename "$f" .json)
    jq -r --arg suite "$suite" --arg commit "$COMMIT" --arg date "$DATE" \
      'to_entries[] | [$suite, .key, .value, $commit, $date] | @csv' "$f"
  done | sort -t, -k1,1 -k2,2
} > "$GAS_CSV"

PROOF_CSV="$OUT_DIR/proof-size-vs-depth.csv"
echo "[3/4] Writing $PROOF_CSV ..."
{
  # proof_only_bytes = 32 * depth (the sibling-hash array alone — this is the "640 bytes at
  #   depth 20" figure already in the dissertation's prose).
  # claim/vote_total_calldata_bytes = measured via abi.encodeWithSelector(...).length against
  #   claimReputation(address,bytes32,uint256,uint256,bytes32[]) and
  #   castVoteWithProofs(uint256,bool,bytes32[],uint256[],bytes32[][]) with 1 role — includes
  #   the 4-byte selector and all fixed/offset/length words, not just the proof array.
  echo "depth,users_at_capacity,proof_only_bytes,claim_total_calldata_bytes,vote_total_calldata_bytes,claim_gas,vote_gas,commit,generated_at"
  for depth in 5 10 15 20 25; do
    case $depth in
      5)  users="32";     key_suffix="32" ;;
      10) users="1024";   key_suffix="1024" ;;
      15) users="32768";  key_suffix="32768" ;;
      20) users="1000000+"; key_suffix="1M" ;;
      25) users="33000000+"; key_suffix="33M" ;;
    esac
    proof_only_bytes=$(( 32 * depth ))
    claim_calldata=$(( 196 + 32 * depth ))
    vote_calldata=$(( 388 + 32 * depth ))
    claim_key="Claim_Depth_${depth}_Users_${key_suffix}"
    vote_key="Vote_Depth_${depth}_Users_${key_suffix}"
    claim_gas=$(jq -r --arg k "$claim_key" '.[$k] // "NA"' snapshots/DRIFTMerkleGasTest.json)
    vote_gas=$(jq -r --arg k "$vote_key" '.[$k] // "NA"' snapshots/DRIFTVoteGasTest.json)
    echo "$depth,$users,$proof_only_bytes,$claim_calldata,$vote_calldata,$claim_gas,$vote_gas,$COMMIT,$DATE"
  done
} > "$PROOF_CSV"

NAIVE_CSV="$OUT_DIR/naive-batch-regression.csv"
echo "[4/4] Writing $NAIVE_CSV and fitting the O(N) regression ..."
{
  echo "batch_size,gas,commit,generated_at"
  jq -r --arg commit "$COMMIT" --arg date "$DATE" \
    'to_entries[] | [(.key | sub("BatchSize_"; "") | tonumber), .value, $commit, $date] | @csv' \
    snapshots/DRIFTNaiveBatchGasTest.json | sort -t, -k1,1n
} > "$NAIVE_CSV"

python3 - "$NAIVE_CSV" <<'PYEOF'
import csv, sys
xs, ys = [], []
with open(sys.argv[1]) as f:
    for row in csv.DictReader(f):
        xs.append(float(row["batch_size"]))
        ys.append(float(row["gas"]))
n = len(xs)
mean_x = sum(xs) / n
mean_y = sum(ys) / n
cov = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
var_x = sum((x - mean_x) ** 2 for x in xs)
slope = cov / var_x
intercept = mean_y - slope * mean_x
ss_res = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(xs, ys))
ss_tot = sum((y - mean_y) ** 2 for y in ys)
r2 = 1 - ss_res / ss_tot
boundary = (30_000_000 - intercept) / slope
print(f"  slope       = {slope:,.1f} gas/node")
print(f"  intercept   = {intercept:,.1f} gas")
print(f"  R^2         = {r2:.6f}")
print(f"  30M-gas boundary (this reconstruction): N ~= {boundary:.0f} nodes")
PYEOF

echo "Done. Wrote $GAS_CSV, $PROOF_CSV, $NAIVE_CSV (commit $COMMIT)."
