import { describe, test, expect, beforeAll } from 'vitest';
import { id, Interface, Contract, Wallet, JsonRpcProvider, NonceManager } from 'ethers';
import { performance } from 'perf_hooks';
import { Drift } from '../../src/drift';
import { EASProvider } from '../../src/providers/EAS';
import { DriftSettler, ScoreEntry } from '../../src/settler';
import { ADDRESSES, SCHEMAS } from '../scenarios/_shared';
import SettlerArtifact from '../../../contracts/out/IDRIFTSettler.sol/IDRIFTSettler.json';

describe('End-to-End Latency and Calldata Bounds ($N = 10^6$)', () => {
  let drift: Drift;
  let settler: DriftSettler;
  const role = id('MEMBER_ROLE');

  let globalTree: any;
  let clientAddress: string;
  const contextName = 'Benchmark.E2E.' + Date.now();
  const contextUID = id(contextName);

  let managedSigner: Wallet;

  beforeAll(async () => {
    const provider = new JsonRpcProvider('http://127.0.0.1:8545');
    const rawWallet = Wallet.createRandom().connect(provider);
    // The NonceManager wraps the wallet and handles nonce synchronization automatically
    const managedSigner = new NonceManager(rawWallet);

    // Instantly fund the new wallet with 10 ETH via Anvil's cheatcode
    await provider.send('anvil_setBalance', [rawWallet.address, '0x8AC7230489E80000']);

    console.log('Balance set');

    drift = new Drift(managedSigner, {
      coreAddress: ADDRESSES.DRIFTCore,
      factoryAddress: ADDRESSES.Factory,
      attestationProvider: new EASProvider('https://sepolia.easscan.org/graphql', SCHEMAS.depin)
    });
    settler = new DriftSettler(managedSigner);

    console.log('DRIFT instatiated');

    const managedSignerAddr = await managedSigner.getAddress();

    const tx = await drift.core.registerContext(contextName);
    if (tx && typeof tx.wait === 'function') {
      await tx.wait();
    }

    console.log('Context registered');

    const initData = new Interface([
      'function initialize(address,address,bytes32,address,uint256,string,bytes32[],uint256[])'
    ]).encodeFunctionData('initialize', [
      ADDRESSES.DRIFTCore,
      ADDRESSES.DRIFTToken,
      contextUID,
      managedSignerAddr,
      50n,
      'EigenTrust',
      [role],
      [1n]
    ]);

    console.log('Interface initialized');

    const correctNonce = await provider.getTransactionCount(rawWallet.address, 'latest');
    console.log('Using nonce:', correctNonce); // should be 1

    clientAddress = await drift.factory.deployClient(
      contextUID,
      ADDRESSES.WeightedGovernanceTemplate,
      initData,
      id('saltE2E'),
      { nonce: correctNonce } // pass it through
    );

    console.log('Client deployed');

    console.log('Generating nodes...');

    // 2. Generate 1,000,000 nodes (Simulating Off-chain Settler State)
    const scores: ScoreEntry[] = [];
    for (let i = 0; i < 999999; i++) {
      scores.push({ node: '0x' + (i + 1).toString(16).padStart(40, '0'), role, score: 100n });
    }
    scores.push({ node: managedSignerAddr, role, score: 100n });

    const { tree, root, signature } = await settler.buildAndSignEpochRoot(clientAddress, contextUID, 1n, scores);
    globalTree = tree;

    const repContract = new Contract(clientAddress, SettlerArtifact.abi, managedSigner);
    await repContract.postEpochRoot(1n, root, signature).then((tx) => tx.wait());
  }, 120000); // Allow 2 minutes for 1M node setup

  test('User Path Latency: Proof Generation to Execution', async () => {
    const managedSignerAddr = await managedSigner.getAddress();

    // T0: Start User Path
    const t0 = performance.now();

    // 1. User extracts proof from local/gateway tree
    const payload = settler.generateProofOfStatePayload(globalTree, contextUID, managedSignerAddr, 1n);
    const t1 = performance.now();
    const proofExtractionLatencyMs = t1 - t0;

    // 2. Measure calldata size dynamically
    // Each hash is 32 bytes. At 1M nodes, depth is 20.
    const siblingCount = payload.proofs[0].length;
    const proofBytes = siblingCount * 32;

    console.log(`\n--- BENCHMARK RESULTS ---`);
    console.log(`Tree Depth: ${siblingCount}`);
    console.log(`Proof Size: ${proofBytes} bytes`);
    console.log(`Proof Extraction Latency: ${proofExtractionLatencyMs.toFixed(2)} ms`);

    // 3. Execute On-Chain Vote
    const repContract = new Contract(clientAddress, SettlerArtifact.abi, managedSigner);
    const tx = await repContract.claimReputation(managedSignerAddr, role, 100n, 1n, payload.proofs[0]);

    const t2 = performance.now();
    const receipt = await tx.wait();
    const t3 = performance.now();

    const networkRoundTripMs = t2 - t1;
    const blockConfirmationMs = t3 - t2;

    console.log(`Network Round-Trip: ${networkRoundTripMs.toFixed(2)} ms`);
    console.log(`Block Confirmation: ${blockConfirmationMs.toFixed(2)} ms`);
    console.log(`Total Time-to-Claim: ${(t3 - t0).toFixed(2)} ms`);
    console.log(`Gas Used: ${receipt.gasUsed}`);
    console.log(`-------------------------\n`);

    // Assertions for Paper Metrics
    expect(siblingCount).toBeGreaterThanOrEqual(19);
    expect(proofBytes).toBeGreaterThanOrEqual(608); // At least 19 * 32
    expect(proofExtractionLatencyMs).toBeLessThan(50); // Tree lookup should be near-instant
  });

  // test('Aggregate Mass Participation Extrapolation', async () => {
  //   // A single proof at depth 20 is ~640 bytes.
  //   // Ethereum calldata costs 16 gas per non-zero byte.
  //   const bytesPerProof = 640;
  //   const calldataGasPerProof = bytesPerProof * 16;
  //
  //   // Simulate 10,000 simultaneous claims
  //   const simultaneousUsers = 10000;
  //   const aggregateCalldataMB = (bytesPerProof * simultaneousUsers) / (1024 * 1024);
  //   const aggregateCalldataGas = calldataGasPerProof * simultaneousUsers;
  //
  //   console.log(`\n--- AGGREGATE SCALING (10,000 Users) ---`);
  //   console.log(`Aggregate Calldata Size: ${aggregateCalldataMB.toFixed(2)} MB`);
  //   console.log(`Aggregate Calldata Gas: ${aggregateCalldataGas.toLocaleString()} gas`);
  //
  //   // Ethereum Block Target is 15M gas, Limit is 30M gas.
  //   const blockLimit = 30000000;
  //   console.log(
  //     `Percentage of 30M Block Limit consumed purely by calldata: ${((aggregateCalldataGas / blockLimit) * 100).toFixed(2)}%`
  //   );
  //   console.log(`----------------------------------------\n`);
  //
  //   // Strict mathematical assertion for the paper
  //   expect(aggregateCalldataMB).toBeCloseTo(6.1, 1); // ~6.1 - 6.4 MB
  //   expect(aggregateCalldataGas).toBeGreaterThan(100000000); // > 100M gas, far exceeding the 30M limit
  // });
});
