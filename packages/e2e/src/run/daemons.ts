import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExperimentConfig } from '../config.js';
import { LAYOUT } from '../keys.js';
import { deriveWallet } from '../keys.js';
import type { DeployManifest } from '../setup.js';
import type { Log } from '../ops.js';

export const OPERATOR_BIN = fileURLToPath(new URL('../../../operator/dist/bin.js', import.meta.url));

export interface DaemonSpec {
  name: string;
  /** Operator config, without secrets: keys are environment variable names. */
  config: Record<string, unknown>;
  /** Environment variables holding this daemon's keys. Never written to disk. */
  env: Record<string, string>;
  apiUrl?: string;
}

export interface RunServices {
  rpcUrl: string;
  easGraphqlUrl: string;
  ipfsApiUrl: string;
  ipfsGatewayUrl: string;
  ipfsAuthorizationEnv?: string;
}

export interface RunTiming {
  blockTag: 'finalized' | 'latest';
  pollIntervalSeconds: number;
  commitWindowSeconds: number;
  revealWindowSeconds: number;
  executeGraceSeconds: number;
}

/**
 * The operator daemons of an experiment: a Tier 1 settler (serving proofs), one daemon per Tier 2
 * Safe owner (owner 0 serves the relay and proofs; the others write to it over HTTP, signed), and
 * a watcher on the Tier 1 context that challenges omissions. Every daemon records events.
 */
export function daemonSpecs(o: {
  cfg: ExperimentConfig;
  manifest: DeployManifest;
  mnemonic: string;
  services: RunServices;
  timing: RunTiming;
  stateDir: string;
  eventsDir: string;
  runId: string;
}): DaemonSpec[] {
  const { cfg, manifest: m } = o;
  const specs: DaemonSpec[] = [];
  const keyOf = (index: number) => deriveWallet(o.mnemonic, index).privateKey;
  const port = (i: number) => cfg.run.apiPortBase + i;
  const common = (name: string) => ({
    rpcUrl: o.services.rpcUrl,
    blockTag: o.timing.blockTag,
    pollIntervalSeconds: o.timing.pollIntervalSeconds,
    stateDir: join(o.stateDir, 'daemons', name),
    attestations: { kind: 'eas', graphqlUrl: o.services.easGraphqlUrl },
    trees: { kind: 'ipfs', apiUrl: o.services.ipfsApiUrl, gatewayUrl: o.services.ipfsGatewayUrl, ...(o.services.ipfsAuthorizationEnv && { authorizationEnv: o.services.ipfsAuthorizationEnv }) },
    engine: { kind: 'local' },
    recorder: { dir: o.eventsDir, runId: o.runId, process: name }
  });
  const context = (tier: 'tier1' | 'tier2', roles: string[], extra: Record<string, unknown> = {}) => {
    const c = m.contexts[tier]!;
    return { name: tier, client: c.client, roles, schemaUID: m.eas.schemaUID, schemaDefinition: m.eas.schemaDefinition, fromBlock: m.startBlock, ...extra };
  };
  const envName = (name: string, role: string) => `DRIFT_E2E_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${role}`;

  if (m.contexts.tier1) {
    const name = 'tier1-settler';
    specs.push({
      name,
      apiUrl: `http://127.0.0.1:${port(0)}`,
      env: { [envName(name, 'SETTLER')]: keyOf(LAYOUT['tier1-settler']), [envName(name, 'HOT')]: keyOf(LAYOUT['tier1-hot']) },
      config: {
        ...common(name),
        keys: { settler: { env: envName(name, 'SETTLER') }, hotWallet: { env: envName(name, 'HOT') } },
        relay: { kind: 'file', dir: join(o.stateDir, 'daemons', name, 'relay') },
        api: { host: '127.0.0.1', port: port(0), serveRelay: false },
        contexts: [context('tier1', ['tier1'])]
      }
    });
  }
  if (m.contexts.tier2 && m.safe) {
    const relayUrl = `http://127.0.0.1:${port(1)}`;
    for (let i = 0; i < m.safe.owners.length; i++) {
      const name = `tier2-owner-${i}`;
      const serves = i === 0;
      specs.push({
        name,
        apiUrl: serves ? relayUrl : undefined,
        env: { [envName(name, 'OWNER')]: keyOf(LAYOUT.tier2OwnerBase + i), [envName(name, 'HOT')]: keyOf(LAYOUT.tier2HotBase + i) },
        config: {
          ...common(name),
          keys: { owner: { env: envName(name, 'OWNER') }, hotWallet: { env: envName(name, 'HOT') } },
          relay: serves ? { kind: 'file', dir: join(o.stateDir, 'relay') } : { kind: 'http', url: relayUrl },
          ...(serves && { api: { host: '127.0.0.1', port: port(1), serveRelay: true } }),
          contexts: [
            context('tier2', ['tier2-owner'], {
              tier2: {
                safe: m.safe.address,
                commitWindowSeconds: o.timing.commitWindowSeconds,
                revealWindowSeconds: o.timing.revealWindowSeconds,
                maxRounds: cfg.tier2.maxRounds,
                executeGraceSeconds: o.timing.executeGraceSeconds
              }
            })
          ]
        }
      });
    }
  }
  if (m.contexts.tier1 && m.watcher) {
    const name = 'watcher';
    specs.push({
      name,
      apiUrl: `http://127.0.0.1:${port(2)}`,
      env: { [envName(name, 'HOT')]: keyOf(LAYOUT['watcher-hot']) },
      config: {
        ...common(name),
        keys: { hotWallet: { env: envName(name, 'HOT') } },
        relay: { kind: 'file', dir: join(o.stateDir, 'daemons', name, 'relay') },
        api: { host: '127.0.0.1', port: port(2), serveRelay: false },
        contexts: [context('tier1', ['watcher'], { watcher: { challenge: true } })]
      }
    });
  }
  return specs;
}

/** Starts, stops and restarts the daemons as `drift-operator run` child processes. */
export class DaemonManager {
  private readonly procs = new Map<string, ChildProcess>();

  constructor(
    private readonly specs: DaemonSpec[],
    private readonly stateDir: string,
    private readonly log: Log
  ) {}

  spec(name: string): DaemonSpec {
    const s = this.specs.find((x) => x.name === name);
    if (!s) throw new Error(`no daemon ${name}`);
    return s;
  }

  names(): string[] {
    return this.specs.map((s) => s.name);
  }

  running(name: string): boolean {
    const p = this.procs.get(name);
    return !!p && p.exitCode === null && p.signalCode === null;
  }

  async start(name: string): Promise<void> {
    if (this.running(name)) return;
    const s = this.spec(name);
    const dir = join(this.stateDir, 'daemons', name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'operator.json');
    writeFileSync(file, JSON.stringify(s.config, null, 2) + '\n');
    const out = createWriteStream(join(dir, 'operator.log'), { flags: 'a' });
    const proc = spawn(process.execPath, [OPERATOR_BIN, 'run', '--config', file], { env: { ...process.env, ...s.env } });
    proc.stdout.pipe(out);
    proc.stderr.pipe(out);
    proc.once('exit', (code, signal) => {
      if (this.procs.get(name) === proc && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
        this.log(`daemon ${name} exited unexpectedly (code ${code}, signal ${signal}); see ${join(dir, 'operator.log')}`);
      }
    });
    this.procs.set(name, proc);
    if (s.apiUrl) await this.waitHealthy(s.apiUrl, name);
  }

  private async waitHealthy(url: string, name: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`${url}/health`)).ok) return;
      } catch {
        // starting
      }
      if (!this.running(name)) throw new Error(`daemon ${name} exited during start; see its operator.log`);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`daemon ${name} did not become healthy at ${url}`);
  }

  async stop(name: string): Promise<void> {
    const p = this.procs.get(name);
    if (!p || !this.running(name)) return;
    const exited = new Promise((r) => p.once('exit', r));
    p.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    if (this.running(name)) p.kill('SIGKILL');
  }

  async startAll(): Promise<void> {
    for (const s of this.specs) await this.start(s.name);
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.specs.map((s) => this.stop(s.name)));
  }

  killAllSync(): void {
    for (const p of this.procs.values()) if (p.exitCode === null) p.kill('SIGKILL');
  }
}
