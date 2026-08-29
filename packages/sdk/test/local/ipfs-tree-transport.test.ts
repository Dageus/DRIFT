import { describe, it, expect, afterEach, vi } from 'vitest';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { id } from 'ethers';
import { IPFSTreeTransport } from '../../src/merkle/IPFSTreeTransport.js';
import { DriftConfigError, DriftProviderError } from '../../src/errors.js';

const contextUID = id('ipfs-tree-transport.test');
const role = id('ROLE');
const values = [
  [contextUID, '0x1111111111111111111111111111111111111111', role, '100', '1'],
  [contextUID, '0x2222222222222222222222222222222222222222', role, '50', '1']
];
const types = ['bytes32', 'address', 'bytes32', 'uint256', 'uint256'];

describe('IPFSTreeTransport', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uploadTree throws DriftConfigError when apiUrl is not configured', async () => {
    const transport = new IPFSTreeTransport();
    const tree = StandardMerkleTree.of(values, types);
    await expect(transport.uploadTree(tree)).rejects.toThrow(DriftConfigError);
  });

  it('uploadTree posts to /api/v0/add and returns an ipfs:// URI from the response CID', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://127.0.0.1:5001/api/v0/add?cid-version=1');
      return new Response(JSON.stringify({ Hash: 'bafyFakeCID123' }), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const transport = new IPFSTreeTransport({ apiUrl: 'http://127.0.0.1:5001' });
    const tree = StandardMerkleTree.of(values, types);
    const uri = await transport.uploadTree(tree);

    expect(uri).toBe('ipfs://bafyFakeCID123');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uploadTree throws DriftProviderError on a non-ok response', async () => {
    global.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Error' }));

    const transport = new IPFSTreeTransport({ apiUrl: 'http://127.0.0.1:5001' });
    const tree = StandardMerkleTree.of(values, types);
    await expect(transport.uploadTree(tree)).rejects.toThrow(DriftProviderError);
  });

  it('fetchTree resolves an ipfs:// URI against the configured gateway and loads the tree', async () => {
    const dump = StandardMerkleTree.of(values, types).dump();
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://custom.gateway/ipfs/bafyFakeCID123');
      return new Response(JSON.stringify(dump), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const transport = new IPFSTreeTransport({ gatewayUrl: 'https://custom.gateway' });
    const tree = await transport.fetchTree('ipfs://bafyFakeCID123');

    expect(tree.root).toBe(StandardMerkleTree.of(values, types).root);
  });

  it.each([
    ['ipfs://bafyFakeCID123', 'bafyFakeCID123'],
    ['https://some.gateway/ipfs/bafyFakeCID123', 'bafyFakeCID123'],
    ['https://some.gateway/ipfs/bafyFakeCID123?filename=tree.json', 'bafyFakeCID123'],
    ['bafyFakeCID123', 'bafyFakeCID123']
  ])('fetchTree extracts the CID from %s', async (treeURI, expectedCID) => {
    const dump = StandardMerkleTree.of(values, types).dump();
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`https://ipfs.io/ipfs/${expectedCID}`);
      return new Response(JSON.stringify(dump), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const transport = new IPFSTreeTransport();
    await transport.fetchTree(treeURI);
  });

  it('fetchTree throws DriftProviderError on a non-ok response', async () => {
    global.fetch = vi.fn(async () => new Response('not found', { status: 404, statusText: 'Not Found' }));

    const transport = new IPFSTreeTransport();
    await expect(transport.fetchTree('ipfs://missing')).rejects.toThrow(DriftProviderError);
  });
});
