import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { id } from 'ethers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalTreeStore } from '../../src/store/LocalTreeStore.js';

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
    expect(leaf[1]!.toLowerCase()).toBe(nodeA.toLowerCase());
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

  it('loadLeaf needs the role when a node holds several, and loadLeaves returns them all', async () => {
    const store = new LocalTreeStore(storageDir);
    const roleB = id('TA_ROLE');
    const values = [
      [contextUID, nodeA, role, '100', epoch.toString()],
      [contextUID, nodeA, roleB, '7', epoch.toString()],
      [contextUID, nodeB, role, '200', epoch.toString()]
    ];
    await store.saveTree(contextUID, epoch, StandardMerkleTree.of(values, ['bytes32', 'address', 'bytes32', 'uint256', 'uint256']));

    await expect(store.loadLeaf(contextUID, epoch, nodeA)).rejects.toThrow(/holds 2 roles/);
    expect((await store.loadLeaf(contextUID, epoch, nodeA, roleB))[3]).toBe('7');
    expect(await store.loadLeaves(contextUID, epoch, nodeA)).toHaveLength(2);
    expect((await store.loadLeaf(contextUID, epoch, nodeB))[3]).toBe('200');
  });

  it('rejects a tampered file on load', async () => {
    const store = new LocalTreeStore(storageDir);
    const values = [[contextUID, nodeA, role, '100', epoch.toString()]];
    await store.saveTree(contextUID, epoch, StandardMerkleTree.of(values, ['bytes32', 'address', 'bytes32', 'uint256', 'uint256']));
    const file = path.join(storageDir, `${contextUID}_epoch_${epoch}.json`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('"100"', '"1000000"'));

    await expect(store.loadTree(contextUID, epoch)).rejects.toThrow(/not a valid settlement tree/);
  });

  it('refuses a contextUID that is not bytes32, which would otherwise shape the file path', async () => {
    const store = new LocalTreeStore(storageDir);
    await expect(store.loadTree('../../etc/passwd', epoch)).rejects.toThrow(/32-byte hex/);
  });
});
