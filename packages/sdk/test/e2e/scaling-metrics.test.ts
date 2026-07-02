import { describe, test, expect, beforeAll } from 'vitest';
import { Contract, id, Interface } from 'ethers';
import { DriftSettler, ScoreEntry } from '../../src/settler';
import { measureAndLogMetric } from '../utils/metrics';
import { alice, ADDRESSES, SCHEMAS } from '../scenarios/_shared';
import { Drift } from '../../src';
import { EASProvider } from '../../src/providers/EAS';
import SettlerArtifact from '../../../contracts/out/IDRIFTSettler.sol/IDRIFTSettler.json';

const mockUploader = async (tree: any) => `arweave://mock-hash-${Date.now()}`;

describe('DRIFT Scaling & Latency Benchmarks', () => {
  let drift: Drift;
  let settler: DriftSettler;
  const role = id('MEMBER_ROLE');

  beforeAll(() => {
    drift = new Drift(alice, {
      coreAddress: ADDRESSES.DRIFTCore,
      factoryAddress: ADDRESSES.Factory,
      attestationProvider: new EASProvider('https://sepolia.easscan.org/graphql', SCHEMAS.depin)
    });
    settler = new DriftSettler(alice);
  });

  const generateMockScores = async (size: number): Promise<ScoreEntry[]> => {
    const scores: ScoreEntry[] = [];
    for (let i = 0; i < size; i++) {
      const mockAddr = '0x' + (i + 1).toString(16).padStart(40, '0');
      scores.push({ node: mockAddr, role, score: 100n });
    }
    scores.push({ node: await alice.getAddress(), role, score: 100n });
    return scores;
  };

  test('Depth 10 (~1,024 nodes) - Tree Generation & Gas', async () => {
    const contextUID = await drift.core.registerContext('Scaling.Depth10.' + Date.now());
    const aliceAddr = await alice.getAddress();

    const initData = new Interface([
      'function initialize(address,address,bytes32,address,uint256,uint256,string,bytes32[],uint256[])'
    ]).encodeFunctionData('initialize', [
      ADDRESSES.DRIFTCore,
      ADDRESSES.DRIFTToken,
      contextUID,
      aliceAddr,
      50n,
      0n,
      'EigenTrust',
      [role],
      [1n]
    ]);

    const clientAddress = await drift.factory.deployClient(
      contextUID,
      ADDRESSES.WeightedGovernanceTemplate,
      initData,
      id('salt10')
    );
    const repContract = new Contract(clientAddress, SettlerArtifact.abi, alice);

    const scores = await generateMockScores(1023);

    const { root, signature, tree } = await measureAndLogMetric(
      'Tree Gen (Depth 10)',
      Promise.resolve({}),
      async () => await settler.buildAndSignEpochRoot(clientAddress, contextUID, 1n, scores, mockUploader)
    );

    expect(tree.dump().values.length).toBe(1024);

    await measureAndLogMetric(
      'postEpochRoot O(1) (Depth 10)',
      repContract.postEpochRoot(1n, root, '', signature).then((tx) => tx.wait())
    );

    const payload = settler.generateProofOfStatePayload(tree, contextUID, aliceAddr, 1n);

    await measureAndLogMetric(
      'claimReputation O(log n) (Depth 10)',
      repContract.claimReputation(aliceAddr, role, 100n, 1n, payload.proofs[0]).then((tx) => tx.wait())
    );
  });

  test('Depth 20 (~1,000,000 nodes) - Calldata & Execution boundary', async () => {
    const contextUID = await drift.core.registerContext('Scaling.Depth20.' + Date.now());
    const aliceAddr = await alice.getAddress();

    const initData = new Interface([
      'function initialize(address,address,bytes32,address,uint256,uint256,string,bytes32[],uint256[])'
    ]).encodeFunctionData('initialize', [
      ADDRESSES.DRIFTCore,
      ADDRESSES.DRIFTToken,
      contextUID,
      aliceAddr,
      50n,
      0n,
      'EigenTrust',
      [role],
      [1n]
    ]);

    const clientAddress = await drift.factory.deployClient(
      contextUID,
      ADDRESSES.WeightedGovernanceTemplate,
      initData,
      id('salt20')
    );
    const repContract = new Contract(clientAddress, SettlerArtifact.abi, alice);

    const scores = await generateMockScores(999999);

    const { root, signature, tree } = await measureAndLogMetric(
      'Tree Gen (Depth 20)',
      Promise.resolve({}),
      async () => await settler.buildAndSignEpochRoot(clientAddress, contextUID, 2n, scores, mockUploader)
    );

    expect(tree.dump().values.length).toBe(1000000);

    await measureAndLogMetric(
      'postEpochRoot O(1) (Depth 20)',
      repContract.postEpochRoot(2n, root, '', signature).then((tx) => tx.wait())
    );

    const payload = settler.generateProofOfStatePayload(tree, contextUID, aliceAddr, 2n);

    expect(payload.proofs[0].length).toBeGreaterThanOrEqual(19);
    expect(payload.proofs[0].length).toBeLessThanOrEqual(21);

    const txReceipt = (await measureAndLogMetric(
      'claimReputation O(log n) (Depth 20)',
      repContract.claimReputation(aliceAddr, role, 100n, 2n, payload.proofs[0]).then((tx) => tx.wait())
    )) as any;

    expect(BigInt(txReceipt.gasUsed)).toBeLessThan(120000n);
  }, 120000);
});
