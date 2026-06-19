#!/bin/bash
set -e

# rm packages/contracts/deployments/31337.json

pkill -f "anvil --port 8545" 2>/dev/null || true

RPC_PORT=8545

echo "Starting background Anvil node..."
anvil --port $RPC_PORT > anvil.log 2>&1 &


# case "$TARGET_NETWORK" in
#     mainnet)
#         anvil --port $RPC_PORT --block-time 12 --gas-limit 30000000 > anvil_mainnet.log 2>&1 &
#         ;;
#     arbitrum)
#         anvil --port $RPC_PORT --block-time 0.25 --gas-price 100000000 --gas-limit 32000000 > anvil_arbitrum.log 2>&1 &
#         ;;
#     *)
#         echo "No defined network, running default Anvil..."
#         anvil --port $RPC_PORT > anvil.log 2>&1 &
#         ;;
# esac

ANVIL_PID=$!

trap "echo 'Shutting down Anvil (PID: $ANVIL_PID)...'; kill $ANVIL_PID 2>/dev/null" EXIT

echo "Waiting for RPC to become online..."
until cast block-number --rpc-url $RPC_URL > /dev/null 2>&1; do
    sleep 0.5
done

echo "Creating deployments directory..."
mkdir -p packages/contracts/deployments

echo "Running Forge deployment script..."
cd packages/contracts
forge script script/Deploy.s.sol:DeployScript --rpc-url $RPC_URL --broadcast --quiet

cd ../..

cd packages/sdk
echo "Executing Vitest End-to-End Test Suite..."
DEBUG=ethers:prover,ethers:contract npx vitest test/e2e/e2e-latency.test.ts run --reporter verbose

# echo "Executing Vitest Benchmark Test Suite..."
# DEBUG=ethers:prover,ethers:contract npx vitest test/script run --reporter verbose
