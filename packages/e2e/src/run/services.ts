import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { Contract, Interface, keccak256, type Provider } from 'ethers';
import type { Log } from '../ops.js';

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export interface Service {
  url: string;
  close(): Promise<void>;
}

async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${addr.port}`;
}

const close = (server: Server) => new Promise<void>((r) => server.close(() => r()));

const EAS = new Interface([
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
  'function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))'
]);

interface Row {
  id: string;
  schemaId: string;
  attester: string;
  recipient: string;
  timeCreated: number;
  revocationTime: number;
  data: string;
}

/**
 * A stand-in for the EAS GraphQL indexer, for rehearsals on a fork (where no indexer follows the
 * local chain). It answers the queries EASProvider sends from EAS's own `Attested` logs and
 * `getAttestation`, read from the chain on every request, so the daemons see exactly what the
 * chain holds. Revocations are read once per attestation (the experiment never revokes).
 */
export async function easLogIndexer(provider: Provider, eas: string, fromBlock: number): Promise<Service> {
  const known = new Map<string, Row>();
  let scanned = fromBlock - 1;
  const contract = new Contract(eas, EAS, provider);
  let busy: Promise<void> = Promise.resolve();

  const refresh = async () => {
    const head = await provider.getBlockNumber();
    if (head <= scanned) return;
    const logs = await provider.getLogs({ address: eas, topics: [EAS.getEvent('Attested')!.topicHash], fromBlock: scanned + 1, toBlock: head });
    for (const l of logs) {
      const uid = EAS.parseLog(l)!.args.uid as string;
      if (known.has(uid)) continue;
      const a = (await contract.getAttestation!(uid)) as { uid: string; schema: string; time: bigint; revocationTime: bigint; recipient: string; attester: string; data: string };
      known.set(uid, { id: a.uid, schemaId: a.schema, attester: a.attester, recipient: a.recipient, timeCreated: Number(a.time), revocationTime: Number(a.revocationTime), data: a.data });
    }
    scanned = head;
  };

  const server = createServer((req, res) => {
    void readBody(req)
      .then(async (raw) => {
        // Requests refresh one at a time, so concurrent queries never scan the same range twice.
        busy = busy.then(refresh, refresh);
        await busy;
        const { variables: v } = JSON.parse(raw.toString()) as { variables: { schema: string; asOf?: number; recipient?: string; take?: number; skip?: number } };
        const rows = [...known.values()]
          .filter((a) => a.schemaId.toLowerCase() === v.schema.toLowerCase())
          .filter((a) => v.asOf === undefined || a.timeCreated <= v.asOf)
          .filter((a) => v.recipient === undefined || a.recipient.toLowerCase() === v.recipient.toLowerCase())
          .sort((a, b) => a.timeCreated - b.timeCreated || (a.id < b.id ? -1 : 1));
        const skip = v.skip ?? 0;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: { attestations: rows.slice(skip, skip + (v.take ?? rows.length)) } }));
      })
      .catch((err: unknown) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ errors: [String(err)] }));
      });
  });
  const url = await listen(server);
  return { url, close: () => close(server) };
}

/** Kubo's /api/v0/add and /api/v0/pin/add plus a gateway, in memory, for rehearsals. */
export async function ipfsStub(): Promise<Service> {
  const blobs = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/v0/add') {
      void readBody(req).then((raw) => {
        const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')![1]!;
        const part = raw.toString('latin1').split(`--${boundary}`)[1]!;
        const content = Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4, part.lastIndexOf('\r\n')), 'latin1');
        const cid = 'bafk' + keccak256(content).slice(2, 50);
        blobs.set(cid, content);
        res.end(JSON.stringify({ Hash: cid }));
      });
    } else if (req.method === 'POST' && url.pathname === '/api/v0/pin/add') {
      res.end('{}');
    } else if (req.method === 'GET' && url.pathname.startsWith('/ipfs/')) {
      const blob = blobs.get(url.pathname.slice('/ipfs/'.length));
      res.statusCode = blob ? 200 : 404;
      res.end(blob ?? 'not found');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  const url = await listen(server);
  return { url, close: () => close(server) };
}

export interface Kubo {
  apiUrl: string;
  gatewayUrl: string;
  stop(): Promise<void>;
}

/**
 * Starts a local Kubo node with its repository under `dir` (created on first use), RPC API and
 * gateway on loopback only. Needs `ipfs` on PATH (e.g. `nix shell nixpkgs#kubo`). The node joins
 * the public IPFS network, so trees it holds are fetchable by CID from anywhere while it runs.
 */
export async function startKubo(dir: string, ports: { api: number; gateway: number; swarm: number }, log: Log): Promise<Kubo> {
  if (spawnSync('which', ['ipfs']).status !== 0) throw new Error('ipfs (Kubo) is not on PATH; run inside `nix shell nixpkgs#kubo`, or set services.ipfsApiUrlEnv to an existing node');
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, IPFS_PATH: dir };
  const ipfs = (...args: string[]) => {
    const r = spawnSync('ipfs', args, { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ipfs ${args.join(' ')} failed: ${r.stderr}`);
  };
  if (!existsSync(join(dir, 'config'))) {
    ipfs('init', '--profile', 'server');
    log(`initialised a Kubo repository in ${dir}`);
  }
  ipfs('config', 'Addresses.API', `/ip4/127.0.0.1/tcp/${ports.api}`);
  ipfs('config', 'Addresses.Gateway', `/ip4/127.0.0.1/tcp/${ports.gateway}`);
  ipfs('config', '--json', 'Addresses.Swarm', JSON.stringify([`/ip4/0.0.0.0/tcp/${ports.swarm}`, `/ip4/0.0.0.0/udp/${ports.swarm}/quic-v1`]));
  const out = createWriteStream(join(dir, 'daemon.log'), { flags: 'a' });
  const proc: ChildProcess = spawn('ipfs', ['daemon'], { env });
  proc.stdout?.pipe(out);
  proc.stderr?.pipe(out);
  const apiUrl = `http://127.0.0.1:${ports.api}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${apiUrl}/api/v0/id`, { method: 'POST' });
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) throw new Error(`ipfs daemon exited (${proc.exitCode}); see ${join(dir, 'daemon.log')}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`Kubo running: RPC ${apiUrl}, gateway http://127.0.0.1:${ports.gateway}`);
  return {
    apiUrl,
    gatewayUrl: `http://127.0.0.1:${ports.gateway}`,
    stop: async () => {
      if (proc.exitCode !== null) return;
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGINT');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
  };
}
