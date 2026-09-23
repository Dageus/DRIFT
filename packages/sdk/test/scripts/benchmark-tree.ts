/**
 * Merkle tree construction, proof generation, and published tree size vs. context size.
 *
 * SCOPE. Reviewer feedback on the NCA submission asked for the off-chain pipeline to be measured,
 * not just on-chain gas. This script covers the part of that pipeline DRIFT actually implements:
 * building the epoch tree, extracting an inclusion proof, and the byte volume the data
 * availability layer must then host (A4(iv)). Graph retrieval, indexing and distribution are
 * deliberately excluded — those measure The Graph, IPFS or Arweave rather than this protocol, and
 * a figure from one deployment on one day would not generalise.
 *
 * The leaf encoding mirrors DriftSettler.buildAndSignEpochRoot exactly: the same five-field tuple
 * and the same ABI types, so the measured cost is the settler's real cost, not an approximation.
 *
 * Memory is reported as the heap delta across construction. Run with --expose-gc for a figure
 * that is not inflated by uncollected garbage from the preceding size.
 *
 * Run: npx tsx test/scripts/benchmark-tree.ts
 *      node --expose-gc --max-old-space-size=8192 node_modules/.bin/tsx test/scripts/benchmark-tree.ts
 */
import { performance } from 'perf_hooks';
import { writeFileSync } from 'node:fs';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';

const LEAF_TYPES = ['bytes32', 'address', 'bytes32', 'uint256', 'uint256'];
const CONTEXT = '0x' + '11'.repeat(32);
const ROLE = '0x' + '22'.repeat(32);
const EPOCH = '1';
const addr = (i: number) => '0x' + (i + 1).toString(16).padStart(40, '0');

/** Same tuple shape DriftSettler.buildAndSignEpochRoot feeds StandardMerkleTree.of. */
const leaves = (n: number) =>
  Array.from({ length: n }, (_, i) => [CONTEXT, addr(i), ROLE, String(100 + (i % 900)), EPOCH]);

function mb(bytes: number) { return bytes / 1024 / 1024; }

function run(n: number) {
  const values = leaves(n);
  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;

  const t0 = performance.now();
  const tree = StandardMerkleTree.of(values, LEAF_TYPES);
  const buildMs = performance.now() - t0;

  const heapAfter = process.memoryUsage().heapUsed;

  // Proof extraction, averaged over a sample rather than one leaf: OZ walks the tree per call,
  // so a single index is noisy at small N.
  const sample = Math.min(100, n);
  const step = Math.max(1, Math.floor(n / sample));
  const p0 = performance.now();
  let taken = 0;
  for (let i = 0; i < n && taken < sample; i += step) { tree.getProof(i); taken++; }
  const proofMs = (performance.now() - p0) / taken;

  // What the DA layer actually stores and serves for the claim/dispute windows.
  const treeBytes = Buffer.byteLength(JSON.stringify(tree.dump()), 'utf8');

  return { n, buildMs, proofMs, treeBytes, heapMb: mb(heapAfter - heapBefore), root: tree.root };
}

const out = ['n,build_ms,proof_ms,tree_bytes,bytes_per_leaf,heap_delta_mb'];
console.log('N, build_ms, proof_ms, tree_bytes, bytes/leaf, heap_MB');
for (const n of [100, 1000, 10000, 100000]) {
  const r = run(n);
  const bpl = r.treeBytes / r.n;
  out.push(`${r.n},${r.buildMs.toFixed(3)},${r.proofMs.toFixed(4)},${r.treeBytes},${bpl.toFixed(1)},${r.heapMb.toFixed(1)}`);
  console.log(
    `${String(r.n).padEnd(7)} ${r.buildMs.toFixed(1).padStart(9)} ${r.proofMs.toFixed(4).padStart(9)} ` +
    `${String(r.treeBytes).padStart(11)} ${bpl.toFixed(1).padStart(10)} ${r.heapMb.toFixed(1).padStart(8)}`
  );
}
writeFileSync('measurements/tree-construction.csv', out.join('\n') + '\n');
console.log('\n-> measurements/tree-construction.csv');
