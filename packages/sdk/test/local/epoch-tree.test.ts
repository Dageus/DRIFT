import { describe, it, expect } from 'vitest';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { id } from 'ethers';
import { buildEpochTree, checkEpochTree, findLeaves, loadEpochTree, EPOCH_LEAF_ENCODING } from '../../src/merkle/epochTree.js';
import { DriftValidationError } from '../../src/errors.js';

const contextUID = id('epoch-tree.test');
const ROLE_A = id('ROLE_A');
const ROLE_B = id('ROLE_B');
const nodeA = '0xAaAaaAAAaAaaAaAaAaaAAaAaAAAAAaAaaaAAAAaa';
const nodeB = '0x2222222222222222222222222222222222222222';
const epoch = 3n;
const entries = [
  { node: nodeA, role: ROLE_A, score: 10n },
  { node: nodeA, role: ROLE_B, score: 20n },
  { node: nodeB, role: ROLE_A, score: 30n }
];

describe('buildEpochTree', () => {
  it('publishes identical bytes regardless of input order and hex case', () => {
    const shuffled = [entries[2]!, { ...entries[0]!, node: nodeA.toUpperCase().replace('0X', '0x') }, entries[1]!];
    const a = buildEpochTree(contextUID, epoch, entries);
    const b = buildEpochTree(contextUID.toUpperCase().replace('0X', '0x'), epoch, shuffled);
    expect(JSON.stringify(b.dump())).toBe(JSON.stringify(a.dump()));
  });

  it('has the same root as an unsorted StandardMerkleTree over the same leaves', () => {
    const plain = StandardMerkleTree.of(
      entries.map((e) => [contextUID, e.node, e.role, e.score.toString(), epoch.toString()]),
      EPOCH_LEAF_ENCODING
    );
    expect(buildEpochTree(contextUID, epoch, entries).root).toBe(plain.root);
  });
});

describe('checkEpochTree', () => {
  const tree = buildEpochTree(contextUID, epoch, entries);

  it('accepts the committed tree', () => {
    expect(checkEpochTree(tree, { root: tree.root, contextUID, epoch })).toBe(tree);
  });

  it('rejects a tree whose values were tampered with', () => {
    // dump() shares the tree's internal arrays; tamper with a copy.
    const dump = structuredClone(tree.dump());
    dump.values[0]!.value[3] = '999999';
    expect(() => loadEpochTree(dump)).toThrow(/not a valid settlement tree/);
  });

  it('rejects a different tree than the committed root', () => {
    const other = buildEpochTree(contextUID, epoch, [{ node: nodeB, role: ROLE_A, score: 31n }]);
    expect(() => checkEpochTree(other, { root: tree.root })).toThrow(DriftValidationError);
  });

  it('rejects a foreign leaf encoding', () => {
    const foreign = StandardMerkleTree.of([[contextUID]], ['bytes32']);
    expect(() => checkEpochTree(foreign)).toThrow(/leaf encoding/);
  });

  it('rejects leaves from another epoch or context', () => {
    expect(() => checkEpochTree(tree, { epoch: epoch + 1n })).toThrow(/outside the expected epoch/);
    expect(() => checkEpochTree(tree, { contextUID: id('other') })).toThrow(/outside the expected epoch/);
  });
});

describe('findLeaves', () => {
  const tree = buildEpochTree(contextUID, epoch, entries);

  it('returns one leaf per role, each with a proof that verifies', () => {
    const leaves = findLeaves(tree, nodeA);
    expect(leaves).toHaveLength(2);
    for (const l of leaves) expect(StandardMerkleTree.verify(tree.root, EPOCH_LEAF_ENCODING, l.value, l.proof)).toBe(true);
  });

  it('narrows to a role, case-insensitively', () => {
    const [leaf] = findLeaves(tree, nodeA.toLowerCase(), ROLE_B.toUpperCase().replace('0X', '0x'));
    expect(leaf!.value[3]).toBe('20');
  });
});
