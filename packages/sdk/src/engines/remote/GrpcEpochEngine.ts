import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { getAddress, getBytes, hexlify, verifyMessage } from 'ethers';
import { DriftEngineError } from '../../errors.js';
import type { IEpochEngine } from '../epoch/IEpochEngine.js';
import {
  ENGINE_ID,
  canonicalize,
  decodeJournal,
  inputDigest,
  journalHash,
  settle,
  validateInput,
  type EngineEvidence,
  type EpochInput,
  type EpochResult
} from '../epoch/protocol.js';

// Resolves to packages/protos from both src/engines/remote and dist/engines/remote.
const DEFAULT_PROTO_ROOT = fileURLToPath(new URL('../../../../protos', import.meta.url));
const PROTO_FILE = 'drift/engine/v1/engine.proto';

export type EvidenceKind = 'none' | 'signed' | 'risc0';

export interface GrpcEpochEngineConfig {
  /** host:port of a drift-engine server. */
  endpoint: string;
  /** Defaults to insecure, which is only acceptable on loopback or inside a private network. */
  credentials?: grpc.ChannelCredentials;
  /** Evidence the caller requires. A response carrying anything else is rejected. */
  evidence: EvidenceKind;
  /** For 'signed': addresses whose signatures are accepted. Empty or omitted accepts any signer. */
  signers?: string[];
  /** Per-call deadline. Default: 10 minutes, since proving can take that long. */
  deadlineMs?: number;
  /** Directory containing drift/engine/v1/engine.proto. Default: packages/protos in this repo. */
  protoRoot?: string;
}

type Unary = (
  request: unknown,
  options: grpc.CallOptions,
  callback: (err: grpc.ServiceError | null, response: unknown) => void
) => void;

interface ComputeEpochResponse {
  scores: { node: Buffer; score: string }[];
  input_digest: Buffer;
  merkle_root: Buffer;
  journal: Buffer;
  /** Name of the populated oneof member (proto-loader `oneofs: true`). */
  evidence?: 'signed' | 'risc0';
  signed?: { signer: Buffer; signature: Buffer };
  risc0?: { image_id: Buffer; seal: Buffer; receipt: Buffer };
}

interface DescribeResponse {
  engine_id: Buffer;
  engine_name: string;
  evidence_kind: string;
  signer: Buffer;
  image_id: Buffer;
}

const toBuf = (hex: string) => Buffer.from(getBytes(hex));

/**
 * Client for the engine protocol. Treats the server as untrusted: it recomputes the input digest
 * and the Merkle root from the returned scores, checks every journal field, and checks signed
 * evidence. A risc0 receipt is passed through unverified; it is checked by whoever verifies the
 * seal (the on-chain verifier, or `drift-engine verify`).
 */
export class GrpcEpochEngine implements IEpochEngine {
  private readonly client: grpc.Client;
  private readonly signers: Set<string>;

  constructor(private readonly config: GrpcEpochEngineConfig) {
    const definition = protoLoader.loadSync(PROTO_FILE, {
      includeDirs: [config.protoRoot ?? DEFAULT_PROTO_ROOT],
      keepCase: true,
      longs: String,
      defaults: true,
      oneofs: true
    });
    // grpc-js builds service constructors at run time from the descriptor.
    const pkg = grpc.loadPackageDefinition(definition) as unknown as {
      drift: { engine: { v1: { ReputationEngine: grpc.ServiceClientConstructor } } };
    };
    const Service = pkg.drift.engine.v1.ReputationEngine;
    this.client = new Service(config.endpoint, config.credentials ?? grpc.credentials.createInsecure());
    this.signers = new Set((config.signers ?? []).map((s) => s.toLowerCase()));
  }

  close(): void {
    this.client.close();
  }

  private call<Req, Res>(method: string, request: Req): Promise<Res> {
    const deadline = Date.now() + (this.config.deadlineMs ?? 10 * 60_000);
    return new Promise((resolve, reject) => {
      const fn = (this.client as unknown as Record<string, Unary>)[method]!.bind(this.client);
      fn(request, { deadline }, (err, res) => {
        if (err) reject(new DriftEngineError(`DRIFT SDK: engine ${this.config.endpoint} ${method} failed: ${err.message}`, { cause: err }));
        else resolve(res as Res);
      });
    });
  }

  async describe(): Promise<{ engineId: string; engineName: string; evidenceKind: string; signer?: string; imageId?: string }> {
    const r = await this.call<object, DescribeResponse>('Describe', {});
    return {
      engineId: hexlify(r.engine_id),
      engineName: r.engine_name,
      evidenceKind: r.evidence_kind,
      signer: r.signer.length ? getAddress(hexlify(r.signer)) : undefined,
      imageId: r.image_id.length ? hexlify(r.image_id) : undefined
    };
  }

  async computeEpoch(input: EpochInput): Promise<EpochResult> {
    validateInput(input);
    const c = canonicalize(input);
    const request = {
      engine_id: toBuf(ENGINE_ID),
      context_uid: toBuf(c.contextUID),
      epoch: c.epoch.toString(),
      t_e: c.tE.toString(),
      schema_uid: toBuf(c.schemaUID),
      schema_definition: c.schemaDefinition,
      params: { alpha_ppm: c.params.alphaPpm, epsilon_ppm: c.params.epsilonPpm, iterations: c.params.iterations },
      default_weight: c.defaultWeight.toString(),
      records: c.records.map((r) => ({
        uid: toBuf(r.uid),
        attester: toBuf(r.attester),
        subject: toBuf(r.subject),
        timestamp: String(r.timestamp),
        revoked: r.revoked,
        data: toBuf(r.data)
      })),
      members: c.members.map((m) => ({ node: toBuf(m.node), role: toBuf(m.role) })),
      pretrust: c.pretrust.map((w) => ({ node: toBuf(w.node), weight: w.weight.toString() }))
    };

    const res = await this.call<typeof request, ComputeEpochResponse>('ComputeEpoch', request);
    return this.verify(c, res);
  }

  private fail(what: string): never {
    throw new DriftEngineError(`DRIFT SDK: engine ${this.config.endpoint} returned ${what}.`);
  }

  private verify(c: EpochInput, res: ComputeEpochResponse): EpochResult {
    const scores = new Map<string, bigint>();
    for (const s of res.scores) {
      scores.set(hexlify(s.node).toLowerCase(), BigInt(s.score));
    }

    const digest = inputDigest(c);
    if (hexlify(res.input_digest) !== digest) this.fail('a digest of a different input');

    const { entries, merkleRoot } = settle(c, scores);
    if (hexlify(res.merkle_root) !== merkleRoot) this.fail('a Merkle root that does not match its scores');

    const journalBytes = hexlify(res.journal);
    const journal = decodeJournal(journalBytes);
    if (
      journal.engineId !== ENGINE_ID.toLowerCase() ||
      journal.contextUID !== c.contextUID ||
      journal.epoch !== c.epoch ||
      journal.tE !== c.tE ||
      journal.inputDigest !== digest ||
      journal.merkleRoot !== merkleRoot
    ) {
      this.fail('a journal that does not match the request');
    }

    const evidence = this.checkEvidence(res, journalBytes);
    return { scores, entries, inputDigest: digest, merkleRoot, journal, journalBytes, evidence };
  }

  private checkEvidence(res: ComputeEpochResponse, journalBytes: string): EngineEvidence {
    const kind: EvidenceKind = res.evidence ?? 'none';
    if (kind !== this.config.evidence) this.fail(`'${kind}' evidence where '${this.config.evidence}' is required`);

    if (kind === 'signed' && res.signed) {
      const signer = getAddress(hexlify(res.signed.signer));
      const signature = hexlify(res.signed.signature);
      if (verifyMessage(journalHash(journalBytes), signature) !== signer) this.fail('a signature that does not recover to its signer');
      if (this.signers.size > 0 && !this.signers.has(signer.toLowerCase())) this.fail(`a signature from unaccepted signer ${signer}`);
      return { kind: 'signed', signatures: [{ signer, signature }] };
    }
    if (kind === 'risc0' && res.risc0) {
      return {
        kind: 'risc0',
        imageId: hexlify(res.risc0.image_id),
        seal: hexlify(res.risc0.seal),
        receipt: new Uint8Array(res.risc0.receipt)
      };
    }
    return { kind: 'none' };
  }
}
