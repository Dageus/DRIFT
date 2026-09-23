/**
 * Sybil-resistance measurement across substitutable reputation engines.
 *
 * SCOPE. DRIFT does not claim Sybil resistance: A5(iv) makes it a property of the chosen Phi_c,
 * and Section "Scope and Non-Goals" places collusion and pre-positioned Sybils outside the
 * protocol boundary. This script therefore does NOT evaluate DRIFT's security. It measures the
 * gamma-bound that A5(iv) leaves as a free parameter, for each engine the protocol can settle,
 * which is evidence for R2 (algorithm agnosticism): the same settlement layer inherits materially
 * different adversarial properties depending on the engine a context selects.
 *
 * MODEL. H honest nodes attest among themselves (ring + fixed offset, out-degree d). S Sybils are
 * fully controlled by one adversary and attest to each other freely — that edge class is costless.
 * The scarce resource is `k`, the number of honest -> Sybil attestations the adversary induces.
 * We sweep k and report the fraction of total reputation mass the Sybil set captures.
 *
 * Run: npx tsx test/scripts/benchmark-sybil.ts
 */
import { AbiCoder } from 'ethers';
import { writeFileSync } from 'node:fs';
import { EigenTrustEngine } from '../../src/engines/EigenTrust.js';
import { WeightedLocalEngine } from '../../src/engines/WeightedLocalEngine.js';
import type { AttestationRecord } from '../../src/types.js';

const coder = AbiCoder.defaultAbiCoder();
const SCHEMA = 'uint256 score';
const addr = (i: number) => '0x' + (i + 1).toString(16).padStart(40, '0');
const rec = (a: string, s: string): AttestationRecord => ({
  uid: `${a}-${s}`, schemaUID: '0x0', attester: a, subject: s,
  timestamp: 0, revoked: false, data: coder.encode(['uint256'], [100])
} as AttestationRecord);

const H = 1000;   // honest population
const S = 100;    // Sybil identities (10% of honest by count)
const D = 5;      // out-degree within each region

function buildGraph(honestToSybilEdges: number): AttestationRecord[] {
  const r: AttestationRecord[] = [];
  for (let i = 0; i < H; i++)
    for (let d = 1; d <= D; d++) {
      const j = (i + d * 7) % H;
      if (j !== i) r.push(rec(addr(i), addr(j)));
    }
  // Sybils vouch for each other at no cost to the adversary.
  for (let i = 0; i < S; i++)
    for (let d = 1; d <= D; d++) {
      const j = (i + d) % S;
      if (j !== i) r.push(rec(addr(H + i), addr(H + j)));
    }
  // The scarce resource: honest endorsements of Sybil identities, spread over distinct Sybils.
  for (let e = 0; e < honestToSybilEdges; e++)
    r.push(rec(addr(e % H), addr(H + (e % S))));
  return r;
}

const honest = new Set(Array.from({ length: H }, (_, i) => addr(i).toLowerCase()));
const isSybil = (a: string) => !honest.has(a.toLowerCase());
const seed = new Set(Array.from({ length: 10 }, (_, i) => addr(i).toLowerCase()));

const configs = [
  { name: 'EigenTrust', pretrust: 'uniform',
    engine: new EigenTrustEngine({ schemaDefinition: SCHEMA }) },
  // Anchoring on the whole honest set presumes the context can already identify Sybils, which is
  // circular. Reported only as an upper bound on what anchoring can buy.
  { name: 'EigenTrust', pretrust: 'all-honest-anchored (upper bound)',
    engine: new EigenTrustEngine({ schemaDefinition: SCHEMA,
      weightResolver: (a: string) => (honest.has(a.toLowerCase()) ? 1n : 0n) }) },
  // The deployable case: a small curated seed set, as EigenTrust's pre-trusted peers are meant
  // to be used. No knowledge of which non-seed identities are Sybil is assumed.
  { name: 'EigenTrust', pretrust: 'seed-anchored (10 nodes)',
    engine: new EigenTrustEngine({ schemaDefinition: SCHEMA,
      weightResolver: (a: string) => (seed.has(a.toLowerCase()) ? 1n : 0n) }) },
  { name: 'WeightedLocal', pretrust: 'n/a',
    engine: new WeightedLocalEngine({ peerWeights: {}, schemaDefinition: SCHEMA }) }
];

const out = ['engine,pretrust,honest_nodes,sybil_nodes,honest_to_sybil_edges,sybil_mass_share,baseline_share,amplification'];
const baseline = S / (H + S);

for (const c of configs) {
  for (const k of [0, 1, 2, 5, 10, 25, 50, 100, 250]) {
    const g = buildGraph(k);
    const all = c.engine.calculateAll(g);
    let sybil = 0n, total = 0n;
    for (const [node, score] of all) { total += score; if (isSybil(node)) sybil += score; }
    const share = total === 0n ? 0 : Number(sybil) / Number(total);
    out.push([c.name, c.pretrust, H, S, k, share.toFixed(5),
              baseline.toFixed(5), (share / baseline).toFixed(3)].join(','));
    console.log(`${c.name}/${c.pretrust}  k=${String(k).padEnd(4)} sybil share ${(share*100).toFixed(2)}%  (${(share/baseline).toFixed(2)}x fair)`);
  }
}
writeFileSync('measurements/sybil-resistance.csv', out.join('\n') + '\n');
console.log(`\nbaseline (S/(H+S)) = ${(baseline*100).toFixed(2)}%   -> measurements/sybil-resistance.csv`);
