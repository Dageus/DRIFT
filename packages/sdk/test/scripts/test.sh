#!/bin/bash
set -euo pipefail

# Accept config file as first parameter, default to standard config
METRICS_FILE="metrics.jsonl"

# Fail fast if required variables are missing
: "${MNEMONIC:?MNEMONIC not set}"
: "${DRIFT_CORE:?DRIFT_CORE not set}"

echo "Running DRIFT scenario tests using config: $CONFIG_FILE"

# Wipe previous run data to prevent metric contamination
rm -f "$METRICS_FILE"

# Run tests. Standard output stays clean because metrics go to the file.
NETWORK=$NETWORK npx vitest run

echo -e "\nGenerating metrics tables..."
npx tsx scripts/run-metrics.ts "$METRICS_FILE"
