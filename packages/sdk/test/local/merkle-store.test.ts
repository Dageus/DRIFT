import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { id } from 'ethers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalTreeStore } from '../../src/merkle/LocalTreeStore';

describe('LocalTreeStore', () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-tree-test-'));
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const contextUID = id('university.context');
  const role = id('STUDENT_ROLE');
  const nodeA = '0x1111111111111111111111111111111111111111';
  const nodeB = '0x2222222222222222222222222222222222222222';
  const epoch = 1n;

  it('round-trips a saved tree', async () => {
    const store = new LocalTreeStore(storageDir);
    const values = [
      [contextUID, nodeA, role, '100', epoch.toString()],
      [contextUID, nodeB, role, '200', epoch.toString()]
    ];
    const tree = StandardMerkleTree.of(values, ['bytes32', 'address', 'bytes32', 'uint256', 'uint256']);

    await store.saveTree(contextUID, epoch, tree);
    const loaded = await store.loadTree(contextUID, epoch);

    expect(loaded.root).toBe(tree.root);
  });

  it('loadLeaf returns the raw leaf values for a known node', async () => {
    const store = new LocalTreeStore(storageDir);
    const values = [
      [contextUID, nodeA, role, '100', epoch.toString()],
      [contextUID, nodeB, role, '200', epoch.toString()]
    ];
    const tree = StandardMerkleTree.of(values, ['bytes32', 'address', 'bytes32', 'uint256', 'uint256']);
    await store.saveTree(contextUID, epoch, tree);

    const leaf = await store.loadLeaf(contextUID, epoch, nodeA);
    expect(leaf[1].toLowerCase()).toBe(nodeA.toLowerCase());
    expect(leaf[3]).toBe('100');
  });

  it('loadLeaf throws for an unregistered node', async () => {
    const store = new LocalTreeStore(storageDir);
    const values = [[contextUID, nodeA, role, '100', epoch.toString()]];
    const tree = StandardMerkleTree.of(values, ['bytes32', 'address', 'bytes32', 'uint256', 'uint256']);
    await store.saveTree(contextUID, epoch, tree);

    await expect(store.loadLeaf(contextUID, epoch, nodeB)).rejects.toThrow(/Leaf not found/);
  });

  it('loadTree throws for a missing tree file', async () => {
    const store = new LocalTreeStore(storageDir);
    await expect(store.loadTree(contextUID, 99n)).rejects.toThrow(/Tree not found/);
  });
});
