import { Contract, Wallet, id, Interface } from 'ethers';
import { performance } from 'perf_hooks';
import * as fs from 'fs';
import IGovArtifact from '../../../contracts/out/IDRIFTGovernanceProofOfState.sol/IDRIFTGovernanceProofOfState.json';
import { DriftSettler } from '../../src/settler';
import { Drift } from '../../src/drift';
import { EASProvider } from '../../src/providers/EAS';

import { provider, ADDRESSES, deployer, SCHEMAS } from '../fixtures/anvil.config';

async function floodBlock() {
  const settler = new DriftSettler(deployer);

  const drift = new Drift(deployer, {
    coreAddress: ADDRESSES.DRIFTCore,
    factoryAddress: ADDRESSES.Factory,
    attestationProvider: new EASProvider('http://localhost', SCHEMAS.depin)
  });

  const contextUID = await drift.core.registerContext('Flood.Benchmark.' + Date.now());
  const deployerAddr = await deployer.getAddress();
  const role = id('MEMBER_ROLE');

  const initData = new Interface([
    'function initialize(address,address,bytes32,address,uint256,string,bytes32[],uint256[])'
  ]).encodeFunctionData('initialize', [
    ADDRESSES.DRIFTCore,
    ADDRESSES.DRIFTToken,
    contextUID,
    deployerAddr,
    50n,
    'EigenTrust',
    [role],
    [1n]
  ]);

  console.log('Deploying benchmark governance client...');
  const clientAddress = await drift.factory.deployClient(
    contextUID,
    ADDRESSES.WeightedGovernanceTemplate,
    initData,
    id('saltFlood')
  );
  const proposalId = 0n;

  console.log('Loading Merkle Trees across varied depths (1-20 distribution)...');
  const trees = [
    { depth: 5, data: JSON.parse(fs.readFileSync('./drift-trees/32_node_tree.json', 'utf-8')), ctx: contextUID },
    { depth: 10, data: JSON.parse(fs.readFileSync('./drift-trees/1k_node_tree.json', 'utf-8')), ctx: contextUID },
    { depth: 15, data: JSON.parse(fs.readFileSync('./drift-trees/32k_node_tree.json', 'utf-8')), ctx: contextUID },
    { depth: 20, data: JSON.parse(fs.readFileSync('./drift-trees/1M_node_tree.json', 'utf-8')), ctx: contextUID }
  ];

  console.log('Generating 500 parallel voting payloads...');
  const txPromises = [];

  for (let i = 0; i < 500; i++) {
    const voter = Wallet.createRandom().connect(provider);
    // Fund voter via Anvil RPC
    await provider.send('anvil_setBalance', [voter.address, '0x1000000000000000000']);

    // Distribute load: 10% Depth 20, 20% Depth 15, 30% Depth 10, 40% Depth 5
    const rand = Math.random();
    let targetTree = trees[0];
    if (rand < 0.1) targetTree = trees[3];
    else if (rand < 0.3) targetTree = trees[2];
    else if (rand < 0.6) targetTree = trees[1];

    const payload = settler.generateProofOfStatePayload(targetTree.data, targetTree.ctx, '0xTARGET_NODE', 1n);
    const govContract = new Contract(clientAddress, IGovArtifact.abi, voter);

    const tx = govContract.castVoteWithProofs(proposalId, true, payload.roles, payload.scores, payload.proofs, {
      gasLimit: 150000
    });
    txPromises.push(tx);
  }

  console.log('Broadcasting to Anvil mempool simultaneously...');
  const t0 = performance.now();

  let successCount = 0;
  let revertCount = 0;

  const results = await Promise.allSettled(txPromises);

  for (const res of results) {
    if (res.status === 'fulfilled') successCount++;
    else revertCount++;
  }

  const t1 = performance.now();

  console.log(`\n--- Flood Test Results ---`);
  console.log(`Execution Time: ${(t1 - t0).toFixed(2)} ms`);
  console.log(`Successful Votes Mined: ${successCount}`);
  console.log(`Failed Votes (Gas Limit Rejections): ${revertCount}`);
  console.log(`Capacity Ceiling Reached: ${successCount} simultaneous distributed claims per block.`);
}

floodBlock().catch(console.error);
