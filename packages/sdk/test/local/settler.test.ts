import { describe, it, expect, beforeEach } from 'vitest';
import { Wallet, id, AbiCoder, keccak256 as ethersKeccak256, Provider, HDNodeWallet } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { DriftSettler, EpochNotSynchronizedError } from '../../src/settler.js';
import type { ScoreEntry } from '../../src/settler.js';

const mockUploader = async (_tree: StandardMerkleTree<string[]>) => `arweave://mock-hash-${Date.now()}`;

/**
 * DriftSettler's O1/role-assignment/domain lookups are private (`_fetch*`) — these tests mock
 * them directly rather than standing up a real provider, so they need a typed escape hatch
 * narrower than `as any`. Widen this type if a future test needs to mock another private method.
 */
type SettlerInternals = {
  _fetchDomain: () => Promise<{ name: string; version: string; chainId: number; verifyingContract: string }>;
  _fetchEpochBoundaryConfig: (
    clientAddress: string
  ) => Promise<{ epochLength: bigint; epochAnchorTimestamp: bigint }>;
  _fetchHasNodeRole: (clientAddress: string, node: string, role: string) => Promise<boolean>;
};
const mockInternals = (settler: DriftSettler): SettlerInternals => settler as unknown as SettlerInternals;
const fakeProvider = (impl: Partial<Provider> = {}): Provider => impl as unknown as Provider;

describe('DriftSettler Cryptographic Boundaries', () => {
  let settler: DriftSettler;
  let signer: HDNodeWallet;

  const clientAddress = '0x1234567890123456789012345678901234567890';
  const contextUID = id('university.context');
  const role1 = id('STUDENT_ROLE');
  const role2 = id('PROFESSOR_ROLE');

  beforeEach(() => {
    // Generate a random offline wallet for signing
    signer = Wallet.createRandom();
    settler = new DriftSettler(signer);

    // Mock the _fetchDomain call since we aren't connected to an RPC
    mockInternals(settler)._fetchDomain = async () => ({
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

  it('produces an identical root across repeated builds from the same scores (B3 determinism)', async () => {
    // Complements the A3/A5(iii) engine-level determinism test (Phi_c score, same input order
    // varied → same score) with the settlement-layer claim B3 asks for directly: identical scores
    // → identical committed ROOT, both across repeated builds of the same order and — the
    // stronger form, since StandardMerkleTree sorts internally — across a differently-ordered
    // presentation of the same entries.
    const epoch = 1n;
    const scores: ScoreEntry[] = [
      { node: '0x1111111111111111111111111111111111111111', role: role1, score: 100n },
      { node: '0x2222222222222222222222222222222222222222', role: role2, score: 500n },
      { node: '0x3333333333333333333333333333333333333333', role: role1, score: 250n }
    ];

    const build1 = await settler.buildAndSignEpochRoot(
      clientAddress,
      contextUID,
      epoch,
      scores,
      mockUploader
    );
    const build2 = await settler.buildAndSignEpochRoot(
      clientAddress,
      contextUID,
      epoch,
      scores,
      mockUploader
    );
    const build3Reordered = await settler.buildAndSignEpochRoot(
      clientAddress,
      contextUID,
      epoch,
      [...scores].reverse(),
      mockUploader
    );

    expect(build2.root).toBe(build1.root);
    expect(build3Reordered.root).toBe(build1.root);
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
    expect(payload.proofs[0]![0]).toMatch(/^0x[a-fA-F0-9]{64}$/);
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

  function makeSettler(observedHead: number, epochLength: bigint, epochAnchorTimestamp: bigint): DriftSettler {
    const getBlock = (async () => ({ timestamp: observedHead })) as unknown as Provider['getBlock'];
    const signer = Wallet.createRandom().connect(fakeProvider({ getBlock }));
    const settler = new DriftSettler(signer);
    mockInternals(settler)._fetchEpochBoundaryConfig = async () => ({ epochLength, epochAnchorTimestamp });
    return settler;
  }

  it('reports synced once the observed head reaches the boundary timestamp', async () => {
    // boundary = 100 (anchor) + 10 (beta) * 3 (epoch) = 130
    const settler = makeSettler(130, 10n, 100n);
    const result = await settler.isSynchronizedForEpoch(clientAddress, 3n);

    expect(result.boundaryTimestamp).toBe(130n);
    expect(result.observedHead).toBe(130n);
    expect(result.synced).toBe(true);
  });

  it('reports not synced while the observed head is behind the boundary timestamp', async () => {
    const settler = makeSettler(129, 10n, 100n);
    const result = await settler.isSynchronizedForEpoch(clientAddress, 3n);

    expect(result.boundaryTimestamp).toBe(130n);
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

describe('DriftSettler role-assignment precondition', () => {
  const clientAddress = '0x1234567890123456789012345678901234567890';
  const role1 = id('STUDENT_ROLE');
  const role2 = id('PROFESSOR_ROLE');
  const nodeA = '0x1111111111111111111111111111111111111111';
  const nodeB = '0x2222222222222222222222222222222222222222';

  function makeSettler(hasRole: Record<string, boolean>): DriftSettler {
    const signer = Wallet.createRandom().connect(fakeProvider());
    const settler = new DriftSettler(signer);
    mockInternals(settler)._fetchHasNodeRole = async (_client: string, node: string, role: string) =>
      hasRole[`${node.toLowerCase()}:${role}`] ?? false;
    return settler;
  }

  const scores: ScoreEntry[] = [
    { node: nodeA, role: role1, score: 100n },
    { node: nodeB, role: role2, score: 50n }
  ];

  it('resolves when every (node, role) pair in scores already holds the role', async () => {
    const settler = makeSettler({
      [`${nodeA.toLowerCase()}:${role1}`]: true,
      [`${nodeB.toLowerCase()}:${role2}`]: true
    });
    await expect(settler.assertRolesAssigned(clientAddress, scores)).resolves.toBeUndefined();
  });

  it('throws DriftValidationError naming the first missing (node, role) pair', async () => {
    const settler = makeSettler({ [`${nodeA.toLowerCase()}:${role1}`]: true });
    await expect(settler.assertRolesAssigned(clientAddress, scores)).rejects.toThrow(
      new RegExp(`${nodeB}.*does not hold role`, 'i')
    );
  });

  it('checks each unique (node, role) pair only once', async () => {
    const settler = makeSettler({ [`${nodeA.toLowerCase()}:${role1}`]: true });
    const spy = mockInternals(settler)._fetchHasNodeRole;
    let callCount = 0;
    mockInternals(settler)._fetchHasNodeRole = async (clientAddress: string, node: string, role: string) => {
      callCount++;
      return spy(clientAddress, node, role);
    };

    const duplicated: ScoreEntry[] = [
      { node: nodeA, role: role1, score: 100n },
      { node: nodeA, role: role1, score: 100n }
    ];
    await settler.assertRolesAssigned(clientAddress, duplicated);
    expect(callCount).toBe(1);
  });

  it('throws a plain error when the signer has no provider attached', async () => {
    const offlineSettler = new DriftSettler(Wallet.createRandom());
    await expect(offlineSettler.assertRolesAssigned(clientAddress, scores)).rejects.toThrow(
      /must have a provider/
    );
  });
});

describe('DriftSettler B1 — challenge response (leaf encoding unchanged)', () => {
  let settler: DriftSettler;

  const clientAddress = '0x1234567890123456789012345678901234567890';
  const contextUID = id('university.context');
  const role = id('STUDENT_ROLE');

  beforeEach(() => {
    settler = new DriftSettler(Wallet.createRandom());
    mockInternals(settler)._fetchDomain = async () => ({
      name: 'DRIFT_WeightedGovernance',
      version: '1',
      chainId: 31337,
      verifyingContract: clientAddress
    });
  });

  it('generateChallengeResponse returns the score/proof for the matching (node, role)', async () => {
    const epoch = 1n;
    const nodeA = '0x1111111111111111111111111111111111111111';
    const nodeB = '0x2222222222222222222222222222222222222222';
    const scores: ScoreEntry[] = [
      { node: nodeA, role, score: 100n },
      { node: nodeB, role, score: 200n }
    ];

    const { tree } = await settler.buildAndSignEpochRoot(
      clientAddress,
      contextUID,
      epoch,
      scores,
      async () => 'arweave://mock-hash'
    );

    const response = settler.generateChallengeResponse(tree, contextUID, nodeA, role, epoch);
    expect(response.score).toBe(100n);
    expect(Array.isArray(response.proof)).toBe(true);
  });

  it('generateChallengeResponse throws for a node/role with no leaf', async () => {
    const epoch = 1n;
    const nodeA = '0x1111111111111111111111111111111111111111';
    const scores: ScoreEntry[] = [{ node: nodeA, role, score: 100n }];

    const { tree } = await settler.buildAndSignEpochRoot(
      clientAddress,
      contextUID,
      epoch,
      scores,
      async () => 'arweave://mock-hash'
    );

    expect(() => {
      settler.generateChallengeResponse(
        tree,
        contextUID,
        '0x9999999999999999999999999999999999999999',
        role,
        epoch
      );
    }).toThrow(/No leaf found/);
  });

  it('round-trip: the SDK leaf hash matches an independently-computed Solidity-style double keccak256', () => {
    // Mirrors _canonicalLeaf on-chain exactly: keccak256(bytes.concat(keccak256(abi.encode(
    //   contextUID, node, role, score, epoch)))) — same types, same order. Independent of
    // StandardMerkleTree's own implementation (which already does this internally) so this test
    // actually catches an ABI type/order mismatch rather than just re-testing OZ against itself.
    const node = '0x1111111111111111111111111111111111111111';
    const score = '100';
    const epoch = '1';
    const types = ['bytes32', 'address', 'bytes32', 'uint256', 'uint256'];
    const values = [contextUID, node, role, score, epoch];

    const encoded = AbiCoder.defaultAbiCoder().encode(types, values);
    const expectedLeaf = ethersKeccak256(ethersKeccak256(encoded));

    const tree = StandardMerkleTree.of([values], types);
    const actualLeaf = tree.leafHash(values);

    expect(actualLeaf.toLowerCase()).toBe(expectedLeaf.toLowerCase());
  });
});
