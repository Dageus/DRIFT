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

deploy_adapter() {
    local adapter_name=$1
    echo "Starting deployment of adapter: $adapter_name to Chain ID: $CHAIN_ID"

    local script_file="script/adapters/${adapter_name}.s.sol"
    local contract_name="Deploy${adapter_name}AdapterScript"

    if [ ! -f "$script_file" ]; then
        echo "Error: Script file $script_file does not exist."
        exit 1
    fi

    mkdir -p ../deployments
    local target_json="../deployments/$CHAIN_ID.json"

    if [ ! -f "$target_json" ]; then
        echo "{}" > "$target_json"
    fi

    forge script "$script_file:$contract_name" "${FORGE_FLAGS[@]}"

    if [ $? -eq 0 ]; then
        echo "Deployment successful! Address saved to $target_json."
    else
        echo "Deployment failed for $adapter_name."
        exit 1
    fi
}

cd packages/contracts || exit 1

if [ -z "${PROVIDER:-}" ]; then
    echo "No provider specified. Deploying all defined adapters."

    for file in script/adapters/*.s.sol; do
        base_name=$(basename "$file" .s.sol)
        deploy_adapter "$base_name"
    done
else
    deploy_adapter "$PROVIDER"
fi

mkdir -p ../deployments
cp "deployments/$CHAIN_ID.json" "../../deployments/$CHAIN_ID.json" 2>/dev/null || echo "No generic deployment JSON found to copy."
