// Runs the TypeScript gRPC client against the Rust engine server. Skipped unless the server has
// been built: `cargo build` in packages/engines.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { GrpcEpochEngine } from '../../src/engines/GrpcEpochEngine.js';
import { CommitteeEpochEngine } from '../../src/engines/CommitteeEpochEngine.js';
import { LocalEpochEngine } from '@drift-network/sdk/engines';
import type { EpochInput } from '@drift-network/sdk/engines';

const BIN = process.env.DRIFT_ENGINE_BIN ?? fileURLToPath(new URL('../../../engines/target/debug/drift-engine', import.meta.url));
const VECTORS = fileURLToPath(new URL('../../../engines/vectors', import.meta.url));

function loadVector(name: string): EpochInput {
  const v = JSON.parse(readFileSync(`${VECTORS}/${name}.json`, 'utf8')).input;
  return {
    ...v,
    epoch: BigInt(v.epoch),
    tE: BigInt(v.tE),
    defaultWeight: BigInt(v.defaultWeight),
    pretrust: v.pretrust.map((w: { node: string; weight: string }) => ({ node: w.node, weight: BigInt(w.weight) }))
  };
}

const keys = [1, 2, 3].map(() => Wallet.createRandom());
const basePort = 40000 + Math.floor(Math.random() * 10000);
const servers: ChildProcess[] = [];

async function startServer(port: number, env: Record<string, string>): Promise<void> {
  const child = spawn(BIN, [], { env: { ...process.env, DRIFT_ENGINE_LISTEN: `127.0.0.1:${port}`, ...env }, stdio: process.env.DRIFT_ENGINE_LOG ? 'inherit' : 'ignore' });
  servers.push(child);
  const probe = new GrpcEpochEngine({ endpoint: `127.0.0.1:${port}`, evidence: 'none', deadlineMs: 500 });
  for (let i = 0; i < 50; i++) {
    try {
      await probe.describe();
      probe.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`engine on port ${port} did not start`);
}

describe.skipIf(!existsSync(BIN))('Rust engine over gRPC', () => {
  beforeAll(async () => {
    await startServer(basePort, { DRIFT_ENGINE_EVIDENCE: 'none' });
    for (const [i, k] of keys.entries()) {
      await startServer(basePort + 1 + i, { DRIFT_ENGINE_EVIDENCE: 'signed', DRIFT_ENGINE_SIGNING_KEY: k.privateKey });
    }
  }, 30_000);

  afterAll(() => servers.forEach((s) => s.kill()));

  it('returns the same root as the in-process reference', async () => {
    const input = loadVector('random-40');
    const remote = new GrpcEpochEngine({ endpoint: `127.0.0.1:${basePort}`, evidence: 'none' });
    const [r, l] = await Promise.all([remote.computeEpoch(input), new LocalEpochEngine().computeEpoch(input)]);
    expect(r.merkleRoot).toBe(l.merkleRoot);
    expect(r.entries).toEqual(l.entries);
    remote.close();
  });

  it('describes itself and signs journals with its key', async () => {
    const remote = new GrpcEpochEngine({ endpoint: `127.0.0.1:${basePort + 1}`, evidence: 'signed', signers: [keys[0]!.address] });
    expect((await remote.describe()).signer).toBe(keys[0]!.address);
    const r = await remote.computeEpoch(loadVector('edge-cases'));
    expect(r.evidence).toMatchObject({ kind: 'signed', signatures: [{ signer: keys[0]!.address }] });
    remote.close();
  });

  it('rejects a signer the caller does not accept, and the wrong evidence kind', async () => {
    const wrongSigner = new GrpcEpochEngine({ endpoint: `127.0.0.1:${basePort + 1}`, evidence: 'signed', signers: [keys[1]!.address] });
    await expect(wrongSigner.computeEpoch(loadVector('triangle'))).rejects.toThrow(/unaccepted signer/);
    const wantsSigned = new GrpcEpochEngine({ endpoint: `127.0.0.1:${basePort}`, evidence: 'signed' });
    await expect(wantsSigned.computeEpoch(loadVector('triangle'))).rejects.toThrow(/'none' evidence/);
    wrongSigner.close();
    wantsSigned.close();
  });

  it('collects a 2-of-3 committee result and survives one member being down', async () => {
    const members = keys.map((k, i) => new GrpcEpochEngine({ endpoint: `127.0.0.1:${basePort + 1 + i}`, evidence: 'signed', deadlineMs: 2000 }));
    // Member 3 points at a dead port.
    members[2] = new GrpcEpochEngine({ endpoint: `127.0.0.1:${basePort + 9}`, evidence: 'signed', deadlineMs: 500 });
    const committee = new CommitteeEpochEngine({ members, signers: keys.map((k) => k.address), threshold: 2 });
    const r = await committee.computeEpoch(loadVector('random-40'));
    expect(r.evidence.kind).toBe('signed');
    if (r.evidence.kind === 'signed') expect(r.evidence.signatures).toHaveLength(2);

    const strict = new CommitteeEpochEngine({ members, signers: keys.map((k) => k.address), threshold: 3 });
    await expect(strict.computeEpoch(loadVector('random-40'))).rejects.toThrow(/2 of 3 matching signatures/);
    members.forEach((m) => m.close());
  });

  it('rejects an unsupported schema before calling the server', async () => {
    const remote = new GrpcEpochEngine({ endpoint: `127.0.0.1:${basePort}`, evidence: 'none' });
    const input = { ...loadVector('triangle'), schemaDefinition: 'string name' };
    await expect(remote.computeEpoch(input)).rejects.toThrow(/all-uint256/);
    remote.close();
  });

  // Needs a server built with `--features risc0` (nix develop .#risc0); set DRIFT_ENGINE_BIN to the
  // release build for real proofs. RISC0_DEV_MODE=1 runs the
  // guest in the executor and returns a fake receipt, which still checks that the guest commits
  // the same journal as the host.
  it.skipIf(!process.env.DRIFT_ENGINE_RISC0)('proves an epoch in the zkVM', async () => {
    const port = basePort + 20;
    await startServer(port, { DRIFT_ENGINE_EVIDENCE: 'risc0' });
    // A real CPU proof of even a small epoch takes minutes; see the cycle counts in the server log.
    const remote = new GrpcEpochEngine({ endpoint: `127.0.0.1:${port}`, evidence: 'risc0', deadlineMs: 60 * 60_000 });
    const input = loadVector(process.env.DRIFT_ENGINE_RISC0_VECTOR ?? 'edge-cases');
    const [r, l] = await Promise.all([remote.computeEpoch(input), new LocalEpochEngine().computeEpoch(input)]);
    expect(r.merkleRoot).toBe(l.merkleRoot);
    expect(r.evidence.kind).toBe('risc0');
    if (r.evidence.kind === 'risc0') expect(r.evidence.receipt.length).toBeGreaterThan(0);
    remote.close();
  }, 60 * 60_000);
});
