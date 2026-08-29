/**
 * Phase 3 item 1 (CLAUDE.md): Phi_c computation time vs. graph size.
 *
 * The existing benchmark-voting-latency.ts script measures SDK bridging overhead (tree
 * build/proof extraction, ~3.5-4ms) and on-chain settlement/vote cost — NOT Phi_c itself, the
 * reputation-algorithm computation the thesis argues is O(N^2)/O(k*E) and must move off-chain.
 * This script measures that computation directly: EigenTrustEngine.calculateScore over a
 * synthetic attestation graph at N = 10^2, 10^3, 10^4 (measured) and 10^5 (extrapolated).
 *
 * N=10^5 is not run directly: the engine's power-iteration inner loop is a dense O(N^2) pass per
 * iteration (see EigenTrust.ts), so at N=10^5 with the default k_max=10 that is up to 10^11
 * BigInt multiplications — tens of minutes to hours in Node, infeasible to run interactively.
 * Instead the fitted O(N^2) curve from the two largest measured points is used to predict N=10^5,
 * reported alongside the measured points with the extrapolation clearly labelled as such — do
 * not present it as a real measurement in the dissertation without first confirming it against
 * an actual overnight/CI run.
 *
 * Methodology: TRIALS repeated runs per N, reporting mean/median/stdev wall-clock (ms). `k_max` is
 * the engine's configured hard iteration cap (EigenTrustEngine does not expose how many
 * power-iteration steps a run actually took before converging or hitting that cap).
 *
 * Run: npx tsx test/scripts/benchmark-phi-c.ts
 */
import { performance } from 'perf_hooks';
import { AbiCoder } from 'ethers';
import { EigenTrustEngine } from '../../src/engines/EigenTrust.js';
import type { AttestationRecord } from '../../src/types.js';

const SCHEMA = 'uint256 score';
const coder = AbiCoder.defaultAbiCoder();

function addr(i: number): string {
  return '0x' + (i + 1).toString(16).padStart(40, '0');
}

/** Deterministic pseudo-random graph: each node attests to `outDegree` others (wrap-around ring
 *  plus a fixed offset, not true randomness) so the benchmark itself stays reproducible run to
 *  run without needing a seeded RNG dependency. */
function buildGraph(n: number, outDegree: number): AttestationRecord[] {
  const records: AttestationRecord[] = [];
  for (let i = 0; i < n; i++) {
    for (let d = 1; d <= outDegree; d++) {
      const j = (i + d * 7) % n;
      if (j === i) continue;
      records.push({
        uid: `0x${i.toString(16)}-${j.toString(16)}`,
        schemaUID: '0x0',
        attester: addr(i),
        subject: addr(j),
        timestamp: 0,
        revoked: false,
        data: coder.encode(['uint256'], [10n])
      });
    }
  }
  return records;
}

// EigenTrustEngine does not expose how many power-iteration steps it actually ran before
// converging or hitting k_max (see EigenTrust.ts) — the `k_max` column below is the configured
// hard cap (default 10), not an observed convergence count. Reporting the real number would
// require instrumenting the engine itself, which this benchmark deliberately avoids touching.
const K_MAX = 10;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function stdev(xs: number[], m: number): number {
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

interface Result {
  n: number;
  edges: number;
  trials: number;
  meanMs: number;
  medianMs: number;
  stdevMs: number;
  measured: boolean;
}

async function benchmarkN(n: number, outDegree: number, trials: number): Promise<Result> {
  const records = buildGraph(n, outDegree);
  const engine = new EigenTrustEngine({ schemaDefinition: SCHEMA });

  const times: number[] = [];
  for (let t = 0; t < trials; t++) {
    const start = performance.now();
    engine.calculateScore(records);
    const end = performance.now();
    times.push(end - start);
  }

  const m = mean(times);
  return {
    n,
    edges: records.length,
    trials,
    meanMs: m,
    medianMs: median(times),
    stdevMs: stdev(times, m),
    measured: true
  };
}

async function main() {
  console.log('=== Phi_c (EigenTrustEngine) computation time vs. graph size ===\n');
  console.log('N, edges, trials, mean_ms, median_ms, stdev_ms, k_max, measured');

  const results: Result[] = [];

  // Fixed out-degree of 5 keeps the graph sparse-ish and E = O(N) across all sizes, isolating
  // the effect of N on the dense O(N^2) transition-matrix pass rather than also varying E.
  for (const [n, trials] of [
    [100, 20],
    [1000, 10],
    [10000, 3]
  ] as const) {
    const r = await benchmarkN(n, 5, trials);
    results.push(r);
    console.log(
      `${r.n}, ${r.edges}, ${r.trials}, ${r.meanMs.toFixed(3)}, ${r.medianMs.toFixed(3)}, ${r.stdevMs.toFixed(3)}, ${K_MAX}, true`
    );
  }

  // O(N^2) fit for extrapolation. Deliberately uses only the two LARGEST measured points
  // (N=1000, N=10000), not all three: at N=100, fixed per-call overhead (Map/array allocation,
  // BigInt object churn) dominates over the O(N^2) term, so time/N^2 at N=100 is measurably
  // higher than at N=1000/10000 (observed: ~2.87e-3 vs ~1.04e-3/~1.16e-3 in this run) and
  // including it biases the extrapolation upward. The two largest points are closer to the true
  // asymptotic constant.
  const largest = results.slice(-2);
  const a = mean(largest.map((r) => r.meanMs / (r.n * r.n)));
  const predictedAt1e5 = a * 100000 * 100000;
  console.log(
    `100000, N/A, 0, ${predictedAt1e5.toFixed(1)}, N/A, N/A, ${K_MAX}, false  # EXTRAPOLATED from O(N^2) fit over the two largest measured points (a=${a.toExponential(4)}) — NOT measured, see script header`
  );

  console.log(`\n(${(predictedAt1e5 / 1000 / 60).toFixed(1)} minutes extrapolated at N=1e5 — not run directly.)`);
}

main().catch(console.error);
