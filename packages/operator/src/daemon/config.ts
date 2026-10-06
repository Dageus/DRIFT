import { isAddress, isHexString } from 'ethers';
import { DriftConfigError } from '@drift-network/sdk';

/**
 * Operator daemon configuration, read from a JSON file. Secrets never appear in it: keys are named
 * by the environment variable that holds them (`keys.*.env`), and only that name is ever logged.
 */

export type Role = 'tier1' | 'tier2-owner' | 'watcher';
export type BlockTag = 'finalized' | 'safe' | 'latest';

export interface KeyRef {
  /** Environment variable holding a 0x-prefixed secp256k1 private key. */
  env: string;
}

export interface ContextConfig {
  /** Label used in logs and /status. */
  name: string;
  /** The context's governance client. */
  client: string;
  roles: Role[];
  schemaUID: string;
  /** Default: 'uint256 score'. */
  schemaDefinition?: string;
  /** First block to scan for registry and challenge logs, normally the core's deployment block. */
  fromBlock?: number;
  /** Required for role 'tier2-owner'. */
  tier2?: {
    /** The Safe installed as the client's trustedSettler. */
    safe: string;
    /** Commit and reveal windows a proposal from this owner sets. Default 600 each. */
    commitWindowSeconds: number;
    revealWindowSeconds: number;
    /** Rounds tried per epoch before stopping for an operator decision. Default 5. */
    maxRounds: number;
    /** Seconds each backup executor waits per rank before executing itself. Default 60. */
    executeGraceSeconds: number;
  };
  /** Options for role 'watcher'. */
  watcher?: {
    /** Open omission challenges from the hot wallet. Default false: report only. */
    challenge: boolean;
  };
}

export interface OperatorConfig {
  rpcUrl: string;
  /** Head used for the O1 check before settling. Default 'finalized'; 'latest' only on dev chains. */
  blockTag: BlockTag;
  /** Seconds between reconcile ticks. Default 15. */
  pollIntervalSeconds: number;
  /** Directory for the tree store (and the file relay, if used). Default './drift-operator'. */
  stateDir: string;
  /** Settled epochs scanned for withdrawable bonds on each tick. Default 64. */
  bondScanDepth: number;
  keys: {
    /** Tier 1 trusted settler: posts roots and their bonds. */
    settler?: KeyRef;
    /** Pays gas for respondToChallenge, withdrawSettlementBond, challengeOmission, Safe execution. */
    hotWallet?: KeyRef;
    /** Tier 2 Safe owner: off-chain signatures only. */
    owner?: KeyRef;
  };
  attestations: { kind: 'eas'; graphqlUrl: string };
  /**
   * Tier 2 settlement relay shared by the Safe owners. 'file': a directory (default under
   * stateDir), for owners sharing a filesystem or for the owner that serves the relay over HTTP.
   * 'http': another operator's API; writes are signed with keys.owner.
   */
  relay: { kind: 'file'; dir: string } | { kind: 'http'; url: string };
  /**
   * Event recorder: one JSONL file per process under `dir`, named by run id and process name, plus
   * derived metrics on the API's /metrics. Omitted: off.
   */
  recorder?: { dir: string; runId: string; process: string };
  /** HTTP API. Omitted: no API. */
  api?: {
    host: string;
    port: number;
    /** Also serve the Tier 2 relay, backed by relay.dir. Requires relay.kind 'file'. */
    serveRelay: boolean;
    /** Safes the served relay accepts writes for. Default: every tier2.safe in contexts. */
    relaySafes: string[];
  };
  trees: { kind: 'ipfs'; apiUrl?: string; gatewayUrl?: string; authorizationEnv?: string };
  engine: { kind: 'local' } | { kind: 'grpc'; endpoint: string; evidence: 'none' | 'signed'; signers?: string[] };
  contexts: ContextConfig[];
}

const ROLES: Role[] = ['tier1', 'tier2-owner', 'watcher'];
const BLOCK_TAGS: BlockTag[] = ['finalized', 'safe', 'latest'];

/** Collects every problem in one pass, so an operator fixes the file once, not error by error. */
class Checker {
  readonly errors: string[] = [];
  fail(path: string, msg: string): void {
    this.errors.push(`${path}: ${msg}`);
  }
  obj(v: unknown, path: string): Record<string, unknown> | undefined {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    this.fail(path, 'expected an object');
    return undefined;
  }
  str(v: unknown, path: string, opt = false): string | undefined {
    if (v === undefined && opt) return undefined;
    if (typeof v === 'string' && v.length > 0) return v;
    this.fail(path, 'expected a non-empty string');
    return undefined;
  }
  num(v: unknown, path: string, def: number, min: number): number {
    if (v === undefined) return def;
    if (typeof v === 'number' && Number.isInteger(v) && v >= min) return v;
    this.fail(path, `expected an integer >= ${min}`);
    return def;
  }
  oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[], def?: T): T | undefined {
    if (v === undefined && def !== undefined) return def;
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    this.fail(path, `expected one of ${allowed.join(', ')}`);
    return def;
  }
  address(v: unknown, path: string): string | undefined {
    const s = this.str(v, path);
    if (s !== undefined && !isAddress(s)) this.fail(path, 'expected an address');
    return s;
  }
  bytes32(v: unknown, path: string): string | undefined {
    const s = this.str(v, path);
    if (s !== undefined && !isHexString(s, 32)) this.fail(path, 'expected a 32-byte hex string');
    return s;
  }
  key(v: unknown, path: string): KeyRef | undefined {
    if (v === undefined) return undefined;
    const o = this.obj(v, path);
    const env = o && this.str(o.env, `${path}.env`);
    if (env !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(env)) this.fail(`${path}.env`, 'expected an environment variable name');
    if (o && 'key' in o) this.fail(path, 'keys must come from the environment; remove the inline key');
    return env === undefined ? undefined : { env };
  }
}

/** Validates a parsed JSON config, applying defaults. Throws DriftConfigError listing every problem. */
export function parseConfig(raw: unknown): OperatorConfig {
  const c = new Checker();
  const root = c.obj(raw, 'config') ?? {};

  const rpcUrl = c.str(root.rpcUrl, 'rpcUrl') ?? '';
  const blockTag = c.oneOf(root.blockTag, 'blockTag', BLOCK_TAGS, 'finalized')!;
  const pollIntervalSeconds = c.num(root.pollIntervalSeconds, 'pollIntervalSeconds', 15, 1);
  const stateDir = c.str(root.stateDir, 'stateDir', true) ?? './drift-operator';
  const bondScanDepth = c.num(root.bondScanDepth, 'bondScanDepth', 64, 1);

  const k = c.obj(root.keys ?? {}, 'keys') ?? {};
  const keys = { settler: c.key(k.settler, 'keys.settler'), hotWallet: c.key(k.hotWallet, 'keys.hotWallet'), owner: c.key(k.owner, 'keys.owner') };

  const r = c.obj(root.relay ?? { kind: 'file' }, 'relay') ?? {};
  const relayKind = c.oneOf(r.kind, 'relay.kind', ['file', 'http'] as const, 'file');
  const relay: OperatorConfig['relay'] =
    relayKind === 'http'
      ? { kind: 'http', url: c.str(r.url, 'relay.url') ?? '' }
      : { kind: 'file', dir: c.str(r.dir, 'relay.dir', true) ?? `${stateDir}/relay` };

  const a = c.obj(root.attestations, 'attestations') ?? {};
  c.oneOf(a.kind, 'attestations.kind', ['eas'] as const);
  const attestations = { kind: 'eas' as const, graphqlUrl: c.str(a.graphqlUrl, 'attestations.graphqlUrl') ?? '' };

  const t = c.obj(root.trees, 'trees') ?? {};
  c.oneOf(t.kind, 'trees.kind', ['ipfs'] as const);
  const trees = {
    kind: 'ipfs' as const,
    apiUrl: c.str(t.apiUrl, 'trees.apiUrl', true),
    gatewayUrl: c.str(t.gatewayUrl, 'trees.gatewayUrl', true),
    authorizationEnv: c.str(t.authorizationEnv, 'trees.authorizationEnv', true)
  };

  const e = c.obj(root.engine ?? { kind: 'local' }, 'engine') ?? {};
  const engineKind = c.oneOf(e.kind, 'engine.kind', ['local', 'grpc'] as const, 'local');
  let engine: OperatorConfig['engine'] = { kind: 'local' };
  if (engineKind === 'grpc') {
    const signers = e.signers === undefined ? undefined : Array.isArray(e.signers) ? e.signers : (c.fail('engine.signers', 'expected an array'), undefined);
    signers?.forEach((s, i) => c.address(s, `engine.signers[${i}]`));
    engine = {
      kind: 'grpc',
      endpoint: c.str(e.endpoint, 'engine.endpoint') ?? '',
      evidence: c.oneOf(e.evidence, 'engine.evidence', ['none', 'signed'] as const, 'none')!,
      signers: signers as string[] | undefined
    };
  }

  const contexts: ContextConfig[] = [];
  if (!Array.isArray(root.contexts) || root.contexts.length === 0) {
    c.fail('contexts', 'expected a non-empty array');
  } else {
    const names = new Set<string>();
    root.contexts.forEach((raw, i) => {
      const p = `contexts[${i}]`;
      const o = c.obj(raw, p);
      if (!o) return;
      const name = c.str(o.name, `${p}.name`) ?? `#${i}`;
      if (names.has(name)) c.fail(`${p}.name`, `duplicate context name '${name}'`);
      names.add(name);
      const roles: Role[] = [];
      if (!Array.isArray(o.roles) || o.roles.length === 0) c.fail(`${p}.roles`, `expected a non-empty array of ${ROLES.join(', ')}`);
      else o.roles.forEach((r, j) => { const v = c.oneOf(r, `${p}.roles[${j}]`, ROLES); if (v) roles.push(v); });
      if (roles.includes('tier1') && !keys.settler) c.fail(`${p}.roles`, "role 'tier1' needs keys.settler");
      if ((roles.includes('tier1') || roles.includes('tier2-owner')) && !keys.hotWallet) {
        c.fail(`${p}.roles`, "settling roles need keys.hotWallet to answer challenges and withdraw bonds");
      }
      if (roles.includes('tier2-owner') && !keys.owner) c.fail(`${p}.roles`, "role 'tier2-owner' needs keys.owner");
      if (roles.includes('tier1') && roles.includes('tier2-owner')) {
        c.fail(`${p}.roles`, "a context has one trusted settler: choose 'tier1' or 'tier2-owner'");
      }
      let tier2: ContextConfig['tier2'];
      if (o.tier2 !== undefined || roles.includes('tier2-owner')) {
        const t2 = c.obj(o.tier2, `${p}.tier2`) ?? {};
        tier2 = {
          safe: c.address(t2.safe, `${p}.tier2.safe`) ?? '',
          commitWindowSeconds: c.num(t2.commitWindowSeconds, `${p}.tier2.commitWindowSeconds`, 600, 1),
          revealWindowSeconds: c.num(t2.revealWindowSeconds, `${p}.tier2.revealWindowSeconds`, 600, 1),
          maxRounds: c.num(t2.maxRounds, `${p}.tier2.maxRounds`, 5, 1),
          executeGraceSeconds: c.num(t2.executeGraceSeconds, `${p}.tier2.executeGraceSeconds`, 60, 0)
        };
      }
      let watcher: ContextConfig['watcher'];
      if (o.watcher !== undefined) {
        const w = c.obj(o.watcher, `${p}.watcher`) ?? {};
        if (w.challenge !== undefined && typeof w.challenge !== 'boolean') c.fail(`${p}.watcher.challenge`, 'expected a boolean');
        watcher = { challenge: w.challenge === true };
        if (watcher.challenge && !keys.hotWallet) c.fail(`${p}.watcher.challenge`, 'challenging needs keys.hotWallet');
      }
      contexts.push({
        name,
        client: c.address(o.client, `${p}.client`) ?? '',
        roles,
        schemaUID: c.bytes32(o.schemaUID, `${p}.schemaUID`) ?? '',
        schemaDefinition: c.str(o.schemaDefinition, `${p}.schemaDefinition`, true),
        fromBlock: o.fromBlock === undefined ? undefined : c.num(o.fromBlock, `${p}.fromBlock`, 0, 0),
        tier2,
        watcher
      });
    });
  }

  let api: OperatorConfig['api'];
  if (root.api !== undefined) {
    const ap = c.obj(root.api, 'api') ?? {};
    const serveRelay = ap.serveRelay === undefined ? false : ap.serveRelay === true;
    if (ap.serveRelay !== undefined && typeof ap.serveRelay !== 'boolean') c.fail('api.serveRelay', 'expected a boolean');
    if (serveRelay && relay.kind !== 'file') c.fail('api.serveRelay', "serving the relay needs relay.kind 'file' as its store");
    let relaySafes = contexts.flatMap((x) => (x.tier2 ? [x.tier2.safe] : []));
    if (ap.relaySafes !== undefined) {
      if (!Array.isArray(ap.relaySafes)) c.fail('api.relaySafes', 'expected an array of addresses');
      else relaySafes = ap.relaySafes.map((s, i) => c.address(s, `api.relaySafes[${i}]`) ?? '');
    }
    if (serveRelay && relaySafes.length === 0) c.fail('api.relaySafes', 'serving the relay needs at least one Safe');
    api = {
      host: c.str(ap.host, 'api.host', true) ?? '127.0.0.1',
      port: c.num(ap.port, 'api.port', 8080, 0),
      serveRelay,
      relaySafes
    };
  }
  let recorder: OperatorConfig['recorder'];
  if (root.recorder !== undefined) {
    const rc = c.obj(root.recorder, 'recorder') ?? {};
    const runId = c.str(rc.runId, 'recorder.runId') ?? '';
    if (runId && !/^[A-Za-z0-9._-]+$/.test(runId)) c.fail('recorder.runId', 'use letters, digits, dot, dash and underscore only');
    recorder = {
      dir: c.str(rc.dir, 'recorder.dir') ?? '',
      runId,
      process: c.str(rc.process, 'recorder.process', true) ?? (contexts.map((x) => x.name).join('+') || 'operator')
    };
  }
  if (relay.kind === 'http' && contexts.some((x) => x.roles.includes('tier2-owner')) && !keys.owner) {
    c.fail('relay', 'an HTTP relay signs writes with keys.owner');
  }

  if (c.errors.length) {
    throw new DriftConfigError(`DRIFT operator: invalid configuration:\n  - ${c.errors.join('\n  - ')}`);
  }
  return { rpcUrl, blockTag, pollIntervalSeconds, stateDir, bondScanDepth, keys, attestations, relay, api, recorder, trees, engine, contexts };
}
