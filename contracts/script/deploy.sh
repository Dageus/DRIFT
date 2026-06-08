#!/bin/bash
set -euo pipefail

if [ -z "$RPC_URL" ] || [ -z "$PRIVATE_KEY" ]; then
    echo "Error: RPC_URL and PRIVATE_KEY environment variables must be defined."
    exit 1
fi

CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL") || {
    echo "Could not reach RPC endpoint: $RPC_URL"
    exit 1
}

echo "Chain ID: $CHAIN_ID"

NETWORK_DIR="./deployments"
mkdir -p "$NETWORK_DIR"

FORGE_FLAGS=(
    --rpc-url     "$RPC_URL"
    --private-key "$PRIVATE_KEY"
    --broadcast
    -vvvv
)

if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
    echo "✅ Contract verification enabled."
    FORGE_FLAGS+=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY")
fi

forge script script/Deploy.s.sol:DeployScript "${FORGE_FLAGS[@]}"
