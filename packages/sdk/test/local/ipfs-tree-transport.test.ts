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

  it('fetchTree rejects a tree that is not the committed one', async () => {
    const dump = StandardMerkleTree.of(values, types).dump();
    global.fetch = vi.fn(async () => new Response(JSON.stringify(dump), { status: 200 }));

    const transport = new IPFSTreeTransport();
    await expect(transport.fetchTree('ipfs://cid', { root: '0x' + '11'.repeat(32) })).rejects.toThrow(/does not match the expected root/);
  });

  it('fetchTree rejects a tampered tree and a response that is not a tree', async () => {
    // dump() shares arrays with `values`; tamper with a copy.
    const dump = structuredClone(StandardMerkleTree.of(values, types).dump());
    dump.values[1]!.value[3] = '5000';
    global.fetch = vi.fn(async () => new Response(JSON.stringify(dump), { status: 200 }));
    const transport = new IPFSTreeTransport();
    await expect(transport.fetchTree('ipfs://cid')).rejects.toThrow(/not a valid settlement tree/);

    global.fetch = vi.fn(async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }));
    await expect(transport.fetchTree('ipfs://cid')).rejects.toThrow(/not a valid settlement tree/);
  });

  it('pin posts the CID to /api/v0/pin/add', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:5001/api/v0/pin/add?arg=bafyFakeCID123');
      expect(init?.method).toBe('POST');
      return new Response('{}', { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await new IPFSTreeTransport({ apiUrl: 'http://127.0.0.1:5001' }).pin('ipfs://bafyFakeCID123');
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(new IPFSTreeTransport().pin('ipfs://x')).rejects.toThrow(DriftConfigError);
  });
});
