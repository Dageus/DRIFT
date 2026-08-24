import { describe, it, expect, beforeEach } from 'vitest';
import { Wallet, id } from 'ethers';
import { DriftSettler, EpochNotSynchronizedError } from '../../src/settler';
import type { ScoreEntry } from '../../src/settler';

const mockUploader = async (tree) => `arweave://mock-hash-${Date.now()}`;

describe('DriftSettler Cryptographic Boundaries', () => {
  let settler: DriftSettler;
  let signer: Wallet;

  const clientAddress = '0x1234567890123456789012345678901234567890';
  const contextUID = id('university.context');
  const role1 = id('STUDENT_ROLE');
  const role2 = id('PROFESSOR_ROLE');

  beforeEach(() => {
    // Generate a random offline wallet for signing
    signer = Wallet.createRandom();
    settler = new DriftSettler(signer);

    // Mock the _fetchDomain call since we aren't connected to an RPC
    (settler as any)._fetchDomain = async () => ({
      name: 'DRIFT_WeightedGovernance',
      version: '1',
      chainId: 31337,
      verifyingContract: clientAddress
    });
  });

  it('should build a valid StandardMerkleTree and sign the root', async () => {
    const epoch = 1n;
    const scores: ScoreEntry[] = [
      { node: '0x1111111111111111111111111111111111111111', role: role1, score: 100n },
      { node: '0x2222222222222222222222222222222222222222', role: role2, score: 500n }
    ];

    const { root, signature, tree } = await settler.buildAndSignEpochRoot(
      clientAddress,
      contextUID,
      epoch,
      scores,
      mockUploader
    );

    expect(root).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(signature).toMatch(/^0x[a-fA-F0-9]+/);
    expect(tree.dump().values.length).toBe(2);
  });

  it('should correctly generate perfectly parallel ProofOfState arrays', async () => {
    const epoch = 2n;
    const targetNode = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // Target node has two roles, dummy node has one
    const scores: ScoreEntry[] = [
      { node: targetNode, role: role1, score: 100n },
      { node: targetNode, role: role2, score: 800n },
      { node: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', role: role1, score: 50n }
    ];

    const { tree } = await settler.buildAndSignEpochRoot(clientAddress, contextUID, epoch, scores, mockUploader);

    const payload = settler.generateProofOfStatePayload(tree, contextUID, targetNode, epoch);

    expect(payload.roles.length).toBe(2);
    expect(payload.scores.length).toBe(2);
    expect(payload.proofs.length).toBe(2);

    expect(payload.roles).toContain(role1);
    expect(payload.roles).toContain(role2);

    expect(payload.scores).toContain(100n);
    expect(payload.scores).toContain(800n);

    // Each proof should be an array of bytes32 sibling hashes
    expect(Array.isArray(payload.proofs[0])).toBe(true);
    expect(payload.proofs[0][0]).toMatch(/^0x[a-fA-F0-9]{64}$/);
  });

  it('should throw if attempting to generate a payload for an unregistered node/epoch', async () => {
    const epoch = 1n;
    const scores: ScoreEntry[] = [{ node: '0x1111111111111111111111111111111111111111', role: role1, score: 100n }];

    const { tree } = await settler.buildAndSignEpochRoot(clientAddress, contextUID, epoch, scores, mockUploader);

    expect(() => {
      settler.generateProofOfStatePayload(tree, contextUID, '0xGHOST_NODE', epoch);
    }).toThrow(/No reputation claims found/);
  });
});

describe('DriftSettler O1 Synchronization Check', () => {
  const clientAddress = '0x1234567890123456789012345678901234567890';

  function makeSettler(observedHead: number, epochLength: bigint, epochAnchorBlock: bigint): DriftSettler {
    const fakeProvider = { getBlockNumber: async () => observedHead } as any;
    const signer = Wallet.createRandom().connect(fakeProvider);
    const settler = new DriftSettler(signer);
    (settler as any)._fetchEpochBoundaryConfig = async () => ({ epochLength, epochAnchorBlock });
    return settler;
  }

  it('reports synced once the observed head reaches the boundary block', async () => {
    // boundary = 100 (anchor) + 10 (beta) * 3 (epoch) = 130
    const settler = makeSettler(130, 10n, 100n);
    const result = await settler.isSynchronizedForEpoch(clientAddress, 3n);

    expect(result.boundaryBlock).toBe(130n);
    expect(result.observedHead).toBe(130n);
    expect(result.synced).toBe(true);
  });

  it('reports not synced while the observed head is behind the boundary block', async () => {
    const settler = makeSettler(129, 10n, 100n);
    const result = await settler.isSynchronizedForEpoch(clientAddress, 3n);

    expect(result.boundaryBlock).toBe(130n);
    expect(result.synced).toBe(false);
  });

  it('assertSynchronizedForEpoch throws EpochNotSynchronizedError when behind the boundary', async () => {
    const settler = makeSettler(50, 10n, 100n);

    await expect(settler.assertSynchronizedForEpoch(clientAddress, 3n)).rejects.toThrow(
      EpochNotSynchronizedError
    );
  });

  it('assertSynchronizedForEpoch resolves once at or past the boundary', async () => {
    const settler = makeSettler(200, 10n, 100n);
    await expect(settler.assertSynchronizedForEpoch(clientAddress, 3n)).resolves.toBeUndefined();
  });

  it('throws a plain error when the signer has no provider attached', async () => {
    const offlineSettler = new DriftSettler(Wallet.createRandom());
    await expect(offlineSettler.isSynchronizedForEpoch(clientAddress, 1n)).rejects.toThrow(
      /must have a provider/
    );
  });
});
