// Cross-language test vectors for the engine protocol. The TypeScript reference
// (LocalEpochEngine over EigenTrustEngine) produces them; packages/engines/core/tests/vectors.rs
// checks the Rust core against the same files. Regenerate after a deliberate change to Phi_c:
//   UPDATE_ENGINE_VECTORS=1 npm test -- engine-vectors
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AbiCoder, keccak256, toBeHex, toUtf8Bytes } from 'ethers';
import { LocalEpochEngine } from '../../src/engines/epoch/LocalEpochEngine.js';
import { DEFAULT_EIGENTRUST_PARAMS, inputDigest, type EpochInput } from '../../src/engines/epoch/protocol.js';
import type { AttestationRecord } from '../../src/types.js';

const VECTOR_DIR = fileURLToPath(new URL('../../../engines/vectors', import.meta.url));
const coder = AbiCoder.defaultAbiCoder();

const CONTEXT = keccak256(toUtf8Bytes('vectors.context'));
const SCHEMA = keccak256(toUtf8Bytes('vectors.schema'));
const ROLE_A = keccak256(toUtf8Bytes('MEMBER'));
const ROLE_B = keccak256(toUtf8Bytes('REVIEWER'));
const T_E = 1_800_000_000n;

const addr = (i: number) => toBeHex(BigInt(keccak256(toUtf8Bytes(`node-${i}`))) >> 96n, 20);

// Deterministic PRNG (mulberry32) so the random cases are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let uidCounter = 0;
function rec(attester: string, subject: string, data: string, opts: { revoked?: boolean; ts?: number } = {}): AttestationRecord {
  return {
    uid: keccak256(toUtf8Bytes(`uid-${uidCounter++}`)),
    schemaUID: SCHEMA,
    attester,
    subject,
    timestamp: opts.ts ?? Number(T_E) - 1000,
    revoked: opts.revoked ?? false,
    data
  };
}
const score = (v: bigint | number, width = 1) => coder.encode(Array(width).fill('uint256'), [v, ...Array(width - 1).fill(0)]);

function base(over: Partial<EpochInput>): EpochInput {
  return {
    contextUID: CONTEXT,
    epoch: 7n,
    tE: T_E,
    schemaUID: SCHEMA,
    schemaDefinition: 'uint256 score',
    params: DEFAULT_EIGENTRUST_PARAMS,
    defaultWeight: 1n,
    records: [],
    members: [],
    pretrust: [],
    ...over
  };
}

function cases(): Record<string, EpochInput> {
  uidCounter = 0;
  const [a, b, c, d, e] = [0, 1, 2, 3, 4].map(addr) as [string, string, string, string, string];
  const out: Record<string, EpochInput> = {};

  out['triangle'] = base({
    records: [rec(a, b, score(100)), rec(b, c, score(100)), rec(c, a, score(100))],
    members: [a, b, c].map((n) => ({ node: n, role: ROLE_A }))
  });

  out['edge-cases'] = base({
    records: [
      rec(a, b, score(50)),
      rec(a, b, score(25)), // duplicate edge: sums
      rec(a, c, score(10)),
      rec(b, c, score(40)),
      rec(c, a, score(5), { revoked: true }), // revoked: ignored
      rec(d, a, '0x1234'), // too short to decode: ignored
      rec(c, d, score(0)) // zero-score edge: adds d to the graph without changing c's row sum
    ],
    // b holds two roles; e is a member with no records at all.
    members: [
      { node: a, role: ROLE_A },
      { node: b, role: ROLE_A },
      { node: b, role: ROLE_B },
      { node: d, role: ROLE_A },
      { node: e, role: ROLE_A }
    ],
    pretrust: [
      { node: a, weight: 5n },
      { node: c, weight: 0n }
    ],
    defaultWeight: 2n
  });

  out['all-revoked'] = base({
    records: [rec(a, b, score(1), { revoked: true })],
    members: [a, b].map((n) => ({ node: n, role: ROLE_A }))
  });

  out['zero-pretrust-total'] = base({
    records: [rec(a, b, score(3)), rec(b, a, score(1)), rec(b, c, score(2))],
    members: [a, b, c].map((n) => ({ node: n, role: ROLE_A })),
    defaultWeight: 0n
  });

  out['huge-scores'] = base({
    records: [rec(a, b, score(1n << 200n)), rec(a, c, score((1n << 255n) + 17n)), rec(b, a, score(1n))],
    members: [a, b, c].map((n) => ({ node: n, role: ROLE_A })),
    params: { alphaPpm: 200_000, epsilonPpm: 0, iterations: 25 }
  });

  const r = rng(42);
  const nodes = Array.from({ length: 40 }, (_, i) => addr(100 + i));
  const random: AttestationRecord[] = [];
  for (let k = 0; k < 300; k++) {
    const i = Math.floor(r() * nodes.length);
    let j = Math.floor(r() * nodes.length);
    if (j === i) j = (j + 1) % nodes.length;
    random.push(rec(nodes[i]!, nodes[j]!, score(BigInt(Math.floor(r() * 1000)), 2), { revoked: r() < 0.05 }));
  }
  out['random-40'] = base({
    schemaDefinition: 'uint256 score, uint256 maxScore',
    records: random,
    members: nodes.slice(0, 35).map((n, i) => ({ node: n, role: i % 3 === 0 ? ROLE_B : ROLE_A })),
    pretrust: nodes.slice(0, 5).map((n, i) => ({ node: n, weight: BigInt(10 + i) })),
    params: { alphaPpm: 150_000, epsilonPpm: 1, iterations: 30 }
  });

  return out;
}

const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n';

describe('engine protocol vectors', () => {
  const engine = new LocalEpochEngine();

  for (const [name, input] of Object.entries(cases())) {
    it(`${name} matches the committed vector`, async () => {
      const result = await engine.computeEpoch(input);
      const vector = {
        name,
        input,
        expected: {
          inputDigest: result.inputDigest,
          merkleRoot: result.merkleRoot,
          journal: result.journalBytes,
          scores: Object.fromEntries([...result.scores].sort(([x], [y]) => (x < y ? -1 : 1)))
        }
      };
      const path = `${VECTOR_DIR}/${name}.json`;
      if (process.env.UPDATE_ENGINE_VECTORS) {
        mkdirSync(VECTOR_DIR, { recursive: true });
        writeFileSync(path, json(vector));
      }
      expect(json(vector)).toBe(readFileSync(path, 'utf8'));
    });
  }

  it('the digest does not depend on input order or address case', () => {
    const input = cases()['random-40']!;
    const shuffled: EpochInput = {
      ...input,
      contextUID: input.contextUID.toUpperCase().replace('0X', '0x'),
      records: [...input.records].reverse(),
      members: [...input.members].reverse(),
      pretrust: [...input.pretrust].reverse().map((w) => ({ ...w, node: w.node.toUpperCase().replace('0X', '0x') }))
    };
    expect(inputDigest(shuffled)).toBe(inputDigest(input));
  });

  it('rejects records newer than t_E', async () => {
    const input = cases()['triangle']!;
    input.records[0] = { ...input.records[0]!, timestamp: Number(T_E) + 1 };
    await expect(engine.computeEpoch(input)).rejects.toThrow(/newer than the epoch boundary/);
  });
});
