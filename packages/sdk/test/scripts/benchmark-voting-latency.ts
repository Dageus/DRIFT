import { JsonRpcProvider, Contract, Interface, id, Wallet } from 'ethers';
import * as fs from 'fs';
import { performance } from 'perf_hooks';
import IGovArtifact from '../../../contracts/out/IDRIFTGovernanceProofOfState.sol/IDRIFTGovernanceProofOfState.json';
import SettlerArtifact from '../../../contracts/out/IDRIFTSettler.sol/IDRIFTSettler.json';
import { DriftSettler, ScoreEntry } from '../../src/settler';
import { Drift } from '../../src/drift';
import { EASProvider } from '../../src/providers/EAS';

import { ADDRESSES, SCHEMAS } from '../fixtures/anvil.config';

// Standard Foundry mnemonic
const MNEMONIC = process.env.MNEMONIC || 'test test test test test test test test test test test junk';

async function generateTreeAndRunBenchmarks() {
  const provider = new JsonRpcProvider('http://127.0.0.1:8545');

  const deployer = Wallet.fromPhrase(MNEMONIC).deriveChild(0).connect(provider);
  const voter = Wallet.fromPhrase(MNEMONIC).deriveChild(1).connect(provider);

  try {
    await provider.send('anvil_setBalance', [deployer.address, '0x10000000000000000000']);
    await provider.send('anvil_setBalance', [voter.address, '0x10000000000000000000']);
  } catch (e) {}

  const role = id('MEMBER_ROLE');
  const epoch = 1n;
  const contextUID = id('Latency.Benchmark.Shared');

  console.log('Generating 1M node tree in memory...');
  const settler = new DriftSettler(deployer);
  const scores: ScoreEntry[] = [];

  for (let i = 0; i < 999998; i++) {
    scores.push({ node: '0x' + (i + 1).toString(16).padStart(40, '0'), role, score: 10n });
  }

  scores.push({ node: deployer.address, role, score: 1000n });
  scores.push({ node: voter.address, role, score: 1000n });

  const { root, tree } = await settler.buildAndSignEpochRoot(
    ADDRESSES.WeightedGovernanceTemplate,
    contextUID,
    epoch,
    scores
  );

  if (!fs.existsSync('./drift-trees')) fs.mkdirSync('./drift-trees');
  fs.writeFileSync('./drift-trees/1M_node_benchmark.json', JSON.stringify(tree.dump()));

  async function runBenchmark(networkName: string, deployer: Wallet, voterWallet: Wallet) {
    console.log(`\n--- Initiating Voting Benchmark: ${networkName} ---`);

    const drift = new Drift(deployer, {
      coreAddress: ADDRESSES.DRIFTCore,
      factoryAddress: ADDRESSES.Factory,
      attestationProvider: new EASProvider('http://localhost', SCHEMAS.depin)
    });

    await drift.core.registerContext(contextUID);

    const initData = new Interface([
      'function initialize(address,address,bytes32,address,uint256,string,bytes32[],uint256[])'
    ]).encodeFunctionData('initialize', [
      ADDRESSES.DRIFTCore,
      ADDRESSES.DRIFTToken,
      contextUID,
      deployer.address,
      50n,
      'EigenTrust',
      [role],
      [1n]
    ]);

    const clientAddress = await drift.factory.deployClient(
      contextUID,
      ADDRESSES.WeightedGovernanceTemplate,
      initData,
      id(`salt${Date.now()}`)
    );

    const domain = await (settler as any)._fetchDomain(clientAddress);
    const signature = await deployer.signTypedData(
      domain,
      {
        SettleRoot: [
          { name: 'contextUID', type: 'bytes32' },
          { name: 'epoch', type: 'uint256' },
          { name: 'merkleRoot', type: 'bytes32' }
        ]
      },
      { contextUID, epoch, merkleRoot: root }
    );

    const repContract = new Contract(clientAddress, SettlerArtifact.abi, deployer);
    await (await repContract.postEpochRoot(epoch, root, signature)).wait();

    // 3. Create Proposal
    const deployerPayload = settler.generateProofOfStatePayload(tree, contextUID, deployer.address, epoch);
    const govContractDeployer = new Contract(clientAddress, IGovArtifact.abi, deployer);
    const txProp = await govContractDeployer.createProposalWithProofs(
      'Latency Test',
      deployer.address,
      '0x',
      3,
      deployerPayload.roles,
      deployerPayload.scores,
      deployerPayload.proofs
    );
    await txProp.wait();
    const proposalId = 0n; // ID will be 0 for a fresh context

    // =========================================================================
    // BENCHMARK: User Voting Path
    // =========================================================================

    // T1: Fetch Data (Simulated Client I/O)
    const tFetchStart = performance.now();
    const treeData = JSON.parse(fs.readFileSync('./drift-trees/1M_node_benchmark.json', 'utf-8'));
    const tFetchEnd = performance.now();

    // T2: Extract Proof Locally
    const voterSettler = new DriftSettler(voterWallet);
    const tProofStart = performance.now();
    const payload = voterSettler.generateProofOfStatePayload(treeData, contextUID, voterWallet.address, epoch);
    const tProofEnd = performance.now();

    // T3: Transmit and Confirm Vote
    const govContract = new Contract(clientAddress, IGovArtifact.abi, voterWallet);

    const tNetStart = performance.now();
    const tx = await govContract.castVoteWithProofs(proposalId, true, payload.roles, payload.scores, payload.proofs);
    const tNetMempool = performance.now();

    const receipt = await tx.wait(1);
    const tNetConfirm = performance.now();

    // T4: Results
    console.log(`[Client] Tree Load (I/O): ${(tFetchEnd - tFetchStart).toFixed(2)} ms`);
    console.log(`[Client] Proof Extraction: ${(tProofEnd - tProofStart).toFixed(2)} ms`);
    console.log(`[Network] RPC Mempool Ack: ${(tNetMempool - tNetStart).toFixed(2)} ms`);
    console.log(`[Network] Block Confirmation: ${(tNetConfirm - tNetMempool).toFixed(2)} ms`);

    const calldataBytes = (tx.data.length - 2) / 2;
    console.log(`[EVM] Calldata Size: ${calldataBytes} bytes`);
    console.log(`[EVM] Gas Used: ${receipt.gasUsed.toString()}`);
    console.log(`--- Total User Time-to-Vote: ${(tNetConfirm - tFetchStart).toFixed(2)} ms ---`);
  }

  try {
    await runBenchmark('Simulation (12s Block Time)', deployer, voter);
  } catch (err) {
    console.error('\n[!] Simulation Failed. Ensure Anvil is running on port 8545.', err);
  }
}

generateTreeAndRunBenchmarks().catch(console.error);
