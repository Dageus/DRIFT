#!/bin/bash
set -euo pipefail

if [ -z "${RPC_URL:-}" ] || [ -z "${MNEMONIC:-}" ]; then
    echo "Error: RPC_URL and MNEMONIC environment variables must be defined."
    exit 1
fi

CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL") || {
    echo "Could not reach RPC endpoint: $RPC_URL"
    exit 1
}

echo "Starting deployment to Chain ID: $CHAIN_ID"

cd packages/contracts

FORGE_FLAGS=(
    --rpc-url "$RPC_URL"
    --mnemonics "$MNEMONIC"
    --mnemonic-indexes 0
    --broadcast
    -vvvv
)

if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
    echo "Contract verification enabled."
    FORGE_FLAGS+=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY")
fi

forge script script/Deploy.s.sol:DeployScript "${FORGE_FLAGS[@]}"

BROADCAST="broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"

mkdir -p ../deployments
cp "deployments/$CHAIN_ID.json" "../deployments/$CHAIN_ID.json" 2>/dev/null || echo "No deployment JSON found."
