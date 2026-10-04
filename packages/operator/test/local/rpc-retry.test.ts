import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RetryingJsonRpcProvider } from '../../src/rpc/RetryingJsonRpcProvider.js';

interface Req {
  id: number;
  method: string;
  params: unknown[];
}

/**
 * A JSON-RPC server for chain 1 that answers eth_getBalance with the address's last byte, and
 * lets each test decide, per HTTP request, which entries come back rate-limited.
 */
async function rpcServer(limit: (batch: Req[], call: number) => 'http429' | Set<number>, port = 0): Promise<{ url: string; batches: Req[][]; server: Server }> {
  const batches: Req[][] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body) as Req | Req[];
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      batches.push(batch);
      const decision = limit(batch, batches.length);
      if (decision === 'http429') {
        res.writeHead(429, { 'content-type': 'application/json' }).end('{"message":"Too Many Requests"}');
        return;
      }
      const replies = batch.map((r) => {
        // Infura's shape: a bare error with no id and no jsonrpc field.
        if (decision.has(r.id)) return { code: -32005, data: { see: 'https://infura.io/dashboard' }, message: 'Too Many Requests' };
        if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: '0x1' };
        if (r.method === 'eth_getBalance') return { jsonrpc: '2.0', id: r.id, result: '0x' + String(r.params[0]).slice(-2) };
        return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'method not found' } };
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, batches, server };
}

const addr = (i: number) => '0x' + i.toString(16).padStart(40, '0');
const fast = { maxRetries: 4, baseDelayMs: 1, maxDelayMs: 5, staticNetwork: true } as const;

let server: Server | undefined;
let provider: RetryingJsonRpcProvider | undefined;
afterEach(async () => {
  provider?.destroy();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
  provider = undefined;
});

describe('RetryingJsonRpcProvider', () => {
  it('resends only the entries a batch rate-limited, including bare errors with no id', async () => {
    let limitedOnce = false;
    const s = await rpcServer((batch) => {
      // First real batch: rate-limit its last two entries.
      if (limitedOnce || batch.length < 2) return new Set();
      limitedOnce = true;
      return new Set(batch.slice(-2).map((r) => r.id));
    });
    server = s.server;
    provider = new RetryingJsonRpcProvider(s.url, 1, fast);
    const balances = await Promise.all([1, 2, 3, 4, 5].map((i) => provider!.getBalance(addr(i))));
    expect(balances).toEqual([1n, 2n, 3n, 4n, 5n]);
    // The retry carried exactly the two limited requests.
    expect(s.batches.at(-1)).toHaveLength(2);
  });

  it('retries a whole request answered with HTTP 429', async () => {
    const s = await rpcServer((_, call) => (call <= 2 ? 'http429' : new Set()));
    server = s.server;
    provider = new RetryingJsonRpcProvider(s.url, 1, fast);
    expect(await provider.getBalance(addr(7))).toBe(7n);
  });

  it('caps batches at 10 requests', async () => {
    const s = await rpcServer(() => new Set());
    server = s.server;
    provider = new RetryingJsonRpcProvider(s.url, 1, fast);
    await Promise.all(Array.from({ length: 25 }, (_, i) => provider!.getBalance(addr(i + 1))));
    expect(Math.max(...s.batches.map((b) => b.length))).toBeLessThanOrEqual(10);
  });

  it('gives up after maxRetries and lets ethers report the request', async () => {
    const s = await rpcServer((batch) => new Set(batch.map((r) => r.id)));
    server = s.server;
    provider = new RetryingJsonRpcProvider(s.url, 1, fast);
    await expect(provider.getBalance(addr(9))).rejects.toThrow(/rate limited after 4 retries: Too Many Requests/);
    expect(s.batches).toHaveLength(fast.maxRetries + 1);
  });

  it('passes ordinary errors through without retrying', async () => {
    const s = await rpcServer(() => new Set());
    server = s.server;
    provider = new RetryingJsonRpcProvider(s.url, 1, fast);
    await expect(provider.send('eth_unknownMethod', [])).rejects.toThrow();
    expect(s.batches).toHaveLength(1);
  });

  it('retries a request that never left the machine', async () => {
    // Reserve a port, close it, and bring the server up there only after the first attempts were refused.
    const probe = await rpcServer(() => new Set());
    const port = (probe.server.address() as AddressInfo).port;
    await new Promise((r) => probe.server.close(r));
    provider = new RetryingJsonRpcProvider(`http://127.0.0.1:${port}`, 1, { ...fast, maxRetries: 8, baseDelayMs: 20, maxDelayMs: 40 });
    const balance = provider.getBalance(addr(3));
    await new Promise((r) => setTimeout(r, 30));
    const up = await rpcServer(() => new Set(), port);
    server = up.server;
    expect(await balance).toBe(3n);
  });
});
