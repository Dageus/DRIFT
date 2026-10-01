import { describe, it, expect } from 'vitest';
import { Interface, id, type Log, type Provider } from 'ethers';
import { resolveEpochTree } from '../../src/merkle/resolveEpochTree.js';
import { buildEpochTree, checkEpochTree, type EpochTree, type TreeExpectation } from '../../src/merkle/epochTree.js';
import type { ITreeTransport } from '../../src/merkle/ITreeTransport.js';
import { DriftNotFoundError } from '../../src/errors.js';

const iface = new Interface([
  'function contextUID() view returns (bytes32)',
  'function epochRoots(uint256) view returns (bytes32)',
  'event EpochRootPosted(bytes32 indexed contextUID, uint256 indexed epoch, bytes32 merkleRoot, string treeURI)'
]);
const CLIENT = '0x5a312d5B60C4f4229Fa6687baabfBe18d9759904';
const contextUID = id('resolve.test');
const role = id('ROLE');
const epoch = 2n;

const tree = (score: bigint) => buildEpochTree(contextUID, epoch, [{ node: '0x' + '11'.repeat(20), role, score }]);

/** Just enough of a Provider for resolveEpochTree: eth_call for two views, and getLogs. */
function fakeProvider(committedRoot: string, posted: { root: string; uri: string }[]): Provider {
  const logs: Log[] = posted.map((p, i) => {
    const { data, topics } = iface.encodeEventLog('EpochRootPosted', [contextUID, epoch, p.root, p.uri]);
    return { address: CLIENT, data, topics, blockNumber: i + 1, index: 0 } as unknown as Log;
  });
  return {
    call: async (tx: { data: string }) => {
      const fn = iface.parseTransaction({ data: tx.data })!.name;
      return fn === 'contextUID'
        ? iface.encodeFunctionResult('contextUID', [contextUID])
        : iface.encodeFunctionResult('epochRoots', [committedRoot]);
    },
    getLogs: async () => logs,
    getNetwork: async () => ({ chainId: 31337n })
  } as unknown as Provider;
}

/** Serves trees by URI; an unknown URI fails like an unreachable gateway. */
function fakeTransport(trees: Record<string, EpochTree>): ITreeTransport {
  return {
    uploadTree: async () => 'unused',
    fetchTree: async (uri: string, expected?: TreeExpectation) => {
      const t = trees[uri];
      if (!t) throw new Error('gateway timeout');
      return checkEpochTree(t, expected);
    }
  };
}

describe('resolveEpochTree', () => {
  it('returns the tree of the newest event whose root is still committed', async () => {
    const rolledBack = tree(1n);
    const current = tree(2n);
    const provider = fakeProvider(current.root, [
      { root: rolledBack.root, uri: 'ipfs://old' },
      { root: current.root, uri: 'ipfs://new' }
    ]);
    const r = await resolveEpochTree(provider, CLIENT, epoch, fakeTransport({ 'ipfs://old': rolledBack, 'ipfs://new': current }));
    expect(r.treeURI).toBe('ipfs://new');
    expect(r.tree.root).toBe(current.root);
  });

  it('skips an unreachable or wrong URI and falls back to an older event with the same root', async () => {
    const current = tree(2n);
    const provider = fakeProvider(current.root, [
      { root: current.root, uri: 'ipfs://first' },
      { root: current.root, uri: 'ipfs://unreachable' }
    ]);
    const r = await resolveEpochTree(provider, CLIENT, epoch, fakeTransport({ 'ipfs://first': current }));
    expect(r.treeURI).toBe('ipfs://first');
  });

  it('fails when no root is committed, or no posted tree matches it', async () => {
    const zero = '0x' + '00'.repeat(32);
    await expect(resolveEpochTree(fakeProvider(zero, []), CLIENT, epoch, fakeTransport({}))).rejects.toThrow(DriftNotFoundError);

    const current = tree(2n);
    const liar = fakeProvider(current.root, [{ root: current.root, uri: 'ipfs://liar' }]);
    await expect(resolveEpochTree(liar, CLIENT, epoch, fakeTransport({ 'ipfs://liar': tree(3n) }))).rejects.toThrow(
      /no retrievable tree matches/
    );
  });
});
