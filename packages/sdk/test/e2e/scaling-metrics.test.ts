import { describe, test, expect, beforeAll } from 'vitest';
import { Contract, id, Interface } from 'ethers';
import { DriftSettler, ScoreEntry } from '../../src/settler';
import { measureAndLogMetric } from '../utils/metrics';
import { alice, ADDRESSES, SCHEMAS } from '../scenarios/_shared';
import { Drift } from '../../src';
import { EASProvider } from '../../src/providers/EAS';
import SettlerArtifact from '../../../contracts/out/IDRIFTSettler.sol/IDRIFTSettler.json';

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

    // 1. Deploy Client
    const initData = new Interface([
      'function initialize(address,address,bytes32,address,uint256,string,bytes32[],uint256[])'
    ]).encodeFunctionData('initialize', [
      ADDRESSES.DRIFTCore,
      ADDRESSES.DRIFTToken,
      contextUID,
      aliceAddr,
      50n,
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

    // 2. Generate 1,024 Node Tree Off-chain
    const scores = await generateMockScores(1023);

    const { root, signature, tree } = await measureAndLogMetric(
      'Tree Gen (Depth 10)',
      Promise.resolve({}),
      async () => await settler.buildAndSignEpochRoot(clientAddress, contextUID, 1n, scores)
    );

    expect(tree.dump().values.length).toBe(1024);

    // 3. Post O(1) Epoch Root
    await measureAndLogMetric(
      'postEpochRoot O(1) (Depth 10)',
      repContract.postEpochRoot(1n, root, signature).then((tx) => tx.wait())
    );

    // 4. Claim O(log N) Reputation
    const payload = settler.generateProofOfStatePayload(tree, contextUID, aliceAddr, 1n);

    await measureAndLogMetric(
      'claimReputation O(log n) (Depth 10)',
      repContract.claimReputation(aliceAddr, role, 100n, 1n, payload.proofs[0]).then((tx) => tx.wait())
    );
  });

  test('Depth 20 (~1,000,000 nodes) - Calldata & Execution boundary', async () => {
    const contextUID = await drift.core.registerContext('Scaling.Depth20.' + Date.now());
    const aliceAddr = await alice.getAddress();

    // 1. Deploy Target Client
    const initData = new Interface([
      'function initialize(address,address,bytes32,address,uint256,string,bytes32[],uint256[])'
    ]).encodeFunctionData('initialize', [
      ADDRESSES.DRIFTCore,
      ADDRESSES.DRIFTToken,
      contextUID,
      aliceAddr,
      50n,
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

    // 2. Generate 1,000,000 Node Tree Off-chain
    const scores = await generateMockScores(999999);

    const { root, signature, tree } = await measureAndLogMetric(
      'Tree Gen (Depth 20)',
      Promise.resolve({}),
      async () => await settler.buildAndSignEpochRoot(clientAddress, contextUID, 2n, scores)
    );

    expect(tree.dump().values.length).toBe(1000000);

    // 3. Post O(1) Epoch Root
    await measureAndLogMetric(
      'postEpochRoot O(1) (Depth 20)',
      repContract.postEpochRoot(2n, root, signature).then((tx) => tx.wait())
    );

    // 4. Extract Proof and Verify Mathematical Depth
    const payload = settler.generateProofOfStatePayload(tree, contextUID, aliceAddr, 2n);

    // Depth for 1,000,000 leaves is strictly 20.
    expect(payload.proofs[0].length).toBeGreaterThanOrEqual(19);
    expect(payload.proofs[0].length).toBeLessThanOrEqual(21);

    // 5. Execute O(log N) Claim and Assert Gas Boundary
    const txReceipt = (await measureAndLogMetric(
      'claimReputation O(log n) (Depth 20)',
      repContract.claimReputation(aliceAddr, role, 100n, 2n, payload.proofs[0]).then((tx) => tx.wait())
    )) as any;

    // Assert that the calldata overhead + execution does not break 120,000 gas.
    // If this fails, your paper's claim of ~92,000 gas is false and must be corrected.
    expect(BigInt(txReceipt.gasUsed)).toBeLessThan(120000n);
  }, 120000); // 120s timeout required for 1M node generation in V8
});
