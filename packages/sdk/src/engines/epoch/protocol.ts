// TypeScript half of the engine protocol. packages/engines/SPEC.md is normative; the Rust core
// (packages/engines/core) implements the same rules, and packages/engines/vectors pins both to
// identical bytes. Change all three together.
import { AbiCoder, getBytes, keccak256, toUtf8Bytes } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import type { AttestationRecord } from '../../types.js';
import type { ScoreEntry } from '../../settler.js';
import { DriftValidationError } from '../../errors.js';

export const ENGINE_NAME = 'drift.eigentrust.v1';
export const ENGINE_ID = keccak256(toUtf8Bytes(ENGINE_NAME));

export interface EigenTrustParams {
  /** Damping in parts per million (150000 = 0.15). */
  alphaPpm: number;
  /** L1 convergence threshold in parts per million. */
  epsilonPpm: number;
  iterations: number;
}

export const DEFAULT_EIGENTRUST_PARAMS: EigenTrustParams = { alphaPpm: 150_000, epsilonPpm: 100, iterations: 10 };

export interface EpochMember {
  node: string;
  role: string;
}

/** Everything Phi_c reads for one (context, epoch). Nothing else may influence the output. */
export interface EpochInput {
  contextUID: string;
  epoch: bigint;
  /** Epoch boundary timestamp t_E. Every record must have `timestamp <= tE`. */
  tE: bigint;
  schemaUID: string;
  schemaDefinition: string;
  params: EigenTrustParams;
  /** Pre-trust weight of any node without an explicit `pretrust` entry. */
  defaultWeight: bigint;
  /** The attestation set A_c^E: member-filtered records of `schemaUID` up to t_E. */
  records: AttestationRecord[];
  /** Admitted (node, role) pairs; one Merkle leaf each. */
  members: EpochMember[];
  pretrust: { node: string; weight: bigint }[];
}

export interface EngineJournal {
  engineId: string;
  contextUID: string;
  epoch: bigint;
  tE: bigint;
  inputDigest: string;
  merkleRoot: string;
}

export type EngineEvidence =
  | { kind: 'none' }
  | { kind: 'signed'; signatures: { signer: string; signature: string }[] }
  | { kind: 'risc0'; imageId: string; seal: string; receipt: Uint8Array };

export interface EpochResult {
  /** Per-node scores, keyed by lowercase address. */
  scores: Map<string, bigint>;
  /** One entry per member, in canonical member order; feed to DriftSettler.buildAndSignEpochRoot. */
  entries: ScoreEntry[];
  inputDigest: string;
  merkleRoot: string;
  journal: EngineJournal;
  /** ABI encoding of `journal`: the exact bytes the evidence covers. */
  journalBytes: string;
  evidence: EngineEvidence;
}

const coder = AbiCoder.defaultAbiCoder();

const INPUT_TYPE =
  'tuple(bytes32 engineId,bytes32 contextUID,uint256 epoch,uint64 tE,bytes32 schemaUID,string schemaDefinition,' +
  'uint32 alphaPpm,uint32 epsilonPpm,uint32 iterations,uint256 defaultWeight,' +
  'tuple(bytes32 uid,address attester,address subject,uint64 timestamp,bool revoked,bytes data)[] records,' +
  'tuple(address node,bytes32 role)[] members,tuple(address node,uint256 weight)[] pretrust)';

const JOURNAL_TYPE =
  'tuple(bytes32 engineId,bytes32 contextUID,uint256 epoch,uint64 tE,bytes32 inputDigest,bytes32 merkleRoot)';

const LEAF_TYPES = ['bytes32', 'address', 'bytes32', 'uint256', 'uint256'];

const lower = (s: string) => s.toLowerCase();
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Returns a copy in canonical order (records by uid, members by node then role, pre-trust by
 * node) with every hex string lowercased. Lowercase fixed-width hex sorts like the bytes it
 * encodes, which is the order the Rust core uses.
 */
export function canonicalize(input: EpochInput): EpochInput {
  const records = input.records
    .map((r) => ({ ...r, uid: lower(r.uid), attester: lower(r.attester), subject: lower(r.subject), data: lower(r.data) }))
    .sort((a, b) => cmp(a.uid, b.uid));
  const members = input.members
    .map((m) => ({ node: lower(m.node), role: lower(m.role) }))
    .sort((a, b) => cmp(a.node, b.node) || cmp(a.role, b.role));
  const pretrust = input.pretrust.map((w) => ({ node: lower(w.node), weight: w.weight })).sort((a, b) => cmp(a.node, b.node));
  return { ...input, contextUID: lower(input.contextUID), schemaUID: lower(input.schemaUID), records, members, pretrust };
}

export function encodeInput(input: EpochInput): string {
  const c = canonicalize(input);
  return coder.encode(
    [INPUT_TYPE],
    [
      [
        ENGINE_ID,
        c.contextUID,
        c.epoch,
        c.tE,
        c.schemaUID,
        c.schemaDefinition,
        c.params.alphaPpm,
        c.params.epsilonPpm,
        c.params.iterations,
        c.defaultWeight,
        c.records.map((r) => [r.uid, r.attester, r.subject, r.timestamp, r.revoked, r.data]),
        c.members.map((m) => [m.node, m.role]),
        c.pretrust.map((w) => [w.node, w.weight])
      ]
    ]
  );
}

export function inputDigest(input: EpochInput): string {
  return keccak256(encodeInput(input));
}

export function encodeJournal(j: EngineJournal): string {
  return coder.encode([JOURNAL_TYPE], [[j.engineId, j.contextUID, j.epoch, j.tE, j.inputDigest, j.merkleRoot]]);
}

export function decodeJournal(bytes: string | Uint8Array): EngineJournal {
  const [t] = coder.decode([JOURNAL_TYPE], bytes);
  return {
    engineId: lower(t[0]),
    contextUID: lower(t[1]),
    epoch: BigInt(t[2]),
    tE: BigInt(t[3]),
    inputDigest: lower(t[4]),
    merkleRoot: lower(t[5])
  };
}

/** Number of fields of an all-uint256 schema; any other schema is outside the protocol. */
export function schemaWidth(definition: string): number {
  const types = definition.split(',').map((f) => f.trim().split(' ')[0]!);
  if (types.length === 0 || types.some((t) => t !== 'uint256')) {
    throw new DriftValidationError(`DRIFT SDK: engine protocol supports only all-uint256 schemas, got '${definition}'.`);
  }
  return types.length;
}

/** The checks the Rust core makes before computing, so local and remote engines reject alike. */
export function validateInput(input: EpochInput): void {
  if (input.members.length === 0) throw new DriftValidationError('DRIFT SDK: engine input has no members.');
  if (input.params.iterations < 1) throw new DriftValidationError('DRIFT SDK: iterations must be at least 1.');
  if (input.params.alphaPpm > 1_000_000 || input.params.epsilonPpm > 1_000_000) {
    throw new DriftValidationError('DRIFT SDK: alphaPpm and epsilonPpm must not exceed 1000000.');
  }
  schemaWidth(input.schemaDefinition);
  for (const r of input.records) {
    if (BigInt(r.timestamp) > input.tE) {
      throw new DriftValidationError(`DRIFT SDK: record ${r.uid} is newer than the epoch boundary ${input.tE}.`);
    }
  }
}

/** Leaf entries and settlement root for `scores` over the members of a canonical input. */
export function settle(
  canonical: EpochInput,
  scores: Map<string, bigint>
): { entries: ScoreEntry[]; merkleRoot: string } {
  const entries = canonical.members.map((m) => ({ node: m.node, role: m.role, score: scores.get(m.node) ?? 0n }));
  const tree = StandardMerkleTree.of(
    entries.map((e) => [canonical.contextUID, e.node, e.role, e.score.toString(), canonical.epoch.toString()]),
    LEAF_TYPES
  );
  return { entries, merkleRoot: lower(tree.root) };
}

export function journalHash(journalBytes: string): Uint8Array {
  return getBytes(keccak256(journalBytes));
}
