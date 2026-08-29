import { describe, test, expect, beforeAll } from 'vitest';
import { id, Interface, Contract, Wallet, JsonRpcProvider, NonceManager } from 'ethers';
import { performance } from 'perf_hooks';
import { Drift } from '../../src/drift';
import { EASProvider } from '../../src/providers/EAS';
import { DriftSettler, ScoreEntry } from '../../src/settler';
import { ADDRESSES, SCHEMAS } from '../scenarios/_shared';
import SettlerArtifact from '../../../contracts/out/IDRIFTSettler.sol/IDRIFTSettler.json';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';

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
    
    managedSigner = new NonceManager(rawWallet) as any;

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

    const regNodeTx = await drift.core.registerNode(contextUID, '0x');
    if (regNodeTx && typeof regNodeTx.wait === 'function') {
      await regNodeTx.wait();
    }
    console.log('Node registered in context');

    const initData = new Interface([
      'function initialize(address,address,bytes32,address,uint256,uint256,string,bytes32[],uint256[])'
    ]).encodeFunctionData('initialize', [
      ADDRESSES.DRIFTCore,
      ADDRESSES.DRIFTToken,
      contextUID,
      managedSignerAddr,
      50n,
      0n,
      'EigenTrust',
      [role],
      [1n]
    ]);

    console.log('Interface initialized');

    const correctNonce = await provider.getTransactionCount(rawWallet.address, 'latest');
    console.log('Using nonce:', correctNonce);

    clientAddress = await drift.factory.deployClient(
      contextUID,
      ADDRESSES.WeightedGovernanceTemplate,
      initData,
      id('saltE2E'),
      { nonce: correctNonce }
    );

    console.log('Client deployed');

    // reward() requires the role already be assigned — the only entry actually claimed below is
    // managedSignerAddr's, so only its role needs assigning.
    await drift.governance.assignRole(clientAddress, managedSignerAddr, role);

    console.log('Generating nodes...');

    const scores: ScoreEntry[] = [];
    for (let i = 0; i < 999999; i++) {
      if (i % 10 == 0) {
        console.log('.');
      }
      scores.push({ node: '0x' + (i + 1).toString(16).padStart(40, '0'), role, score: 100n });
    }
    scores.push({ node: managedSignerAddr, role, score: 100n });

    const mockUploader = async (tree: StandardMerkleTree<string[]>) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return `arweave://mock-hash-${Date.now()}`;
    };

    const { tree, root, signature, treeURI } = await settler.buildAndSignEpochRoot(
      clientAddress,
      contextUID,
      1n,
      scores,
      mockUploader
    );
    globalTree = tree;

    const repContract = new Contract(clientAddress, SettlerArtifact.abi, managedSigner);
    await repContract.postEpochRoot(1n, root, treeURI, signature).then((tx) => tx.wait());
  }, 800000);

  test('User Path Latency: Proof Generation to Execution', async () => {
    const managedSignerAddr = await managedSigner.getAddress();

    let targetIndex: number | null = null;
    let targetRowValues: string[] | null = null;

    for (const [i, v] of globalTree.entries()) {
      if (v[0] === contextUID && v[1].toLowerCase() === managedSignerAddr.toLowerCase()) {
        targetIndex = i;
        targetRowValues = v;
        break;
      }
    }
    if (targetIndex === null || targetRowValues === null) throw new Error('Signer leaf not found in tree');

    const t0 = performance.now();

    const roles = [targetRowValues[2]];
    const scores = [BigInt(targetRowValues[3])];
    const proofs = [globalTree.getProof(targetIndex)];

    const payload = { roles, scores, proofs };

    const t1 = performance.now();
    const proofExtractionLatencyMs = t1 - t0;

    const siblingCount = payload.proofs[0].length;
    const proofBytes = siblingCount * 32;

    console.log(`\n--- BENCHMARK RESULTS ---`);
    console.log(`Tree Depth: ${siblingCount}`);
    console.log(`Proof Size: ${proofBytes} bytes`);
    console.log(`Proof Extraction Latency: ${proofExtractionLatencyMs.toFixed(2)} ms`);

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

    expect(siblingCount).toBeGreaterThanOrEqual(19);
    expect(proofBytes).toBeGreaterThanOrEqual(608);
    expect(proofExtractionLatencyMs).toBeLessThan(50);
  });

  test('Granular Cryptographic Latency (Paper Metrics)', async () => {
    const managedSignerAddr = await managedSigner.getAddress();

    const tPayloadStart = performance.now();

    const domain = {
      name: 'DRIFT_WeightedGovernance',
      version: '1',
      chainId: 31337,
      verifyingContract: clientAddress
    };
    const types = {
      SettleRoot: [
        { name: 'contextUID', type: 'bytes32' },
        { name: 'epoch', type: 'uint256' },
        { name: 'merkleRoot', type: 'bytes32' },
        { name: 'treeURI', type: 'string' }
      ]
    };
    const value = {
      contextUID,
      epoch: 1n,
      merkleRoot: '0x' + '1'.repeat(64),
      treeURI: 'arweave://dummy'
    };

    const tPayloadEnd = performance.now();
    const payloadLatency = tPayloadEnd - tPayloadStart;

    const tSignStart = performance.now();
    await managedSigner.signTypedData(domain, types, value);
    const tSignEnd = performance.now();
    const signatureLatency = tSignEnd - tSignStart;

    const payload = settler.generateProofOfStatePayload(globalTree, contextUID, managedSignerAddr, 1n);
    const repContract = new Contract(clientAddress, SettlerArtifact.abi, managedSigner);

    const tPrepStart = performance.now();
    await repContract.claimReputation.populateTransaction(
      managedSignerAddr,
      role,
      100n,
      1n,
      payload.proofs[0]
    );
    const tPrepEnd = performance.now();
    const prepLatency = tPrepEnd - tPrepStart;

    console.log(`\n=== PAPER LATENCY METRICS ===`);
    console.log(`EIP-712 payload construction: ${payloadLatency.toFixed(2)} ms`);
    console.log(`Signature generation (secp256k1): ${signatureLatency.toFixed(2)} ms`);
    console.log(`Contract call preparation: ${prepLatency.toFixed(2)} ms`);
    console.log(`=============================\n`);
  });
});
