import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { DriftValidationError } from '../errors.js';
import type { ScoreEntry } from '../settler.js';

/** Leaf encoding of every settlement tree: [contextUID, node, role, score, epoch]. */
export const EPOCH_LEAF_ENCODING = ['bytes32', 'address', 'bytes32', 'uint256', 'uint256'];

export type EpochTree = StandardMerkleTree<string[]>;

/** What a fetched or loaded tree must match before anyone builds a proof from it. */
export interface TreeExpectation {
  /** The root committed on-chain (`epochRoots(epoch)`). */
  root?: string;
  contextUID?: string;
  epoch?: bigint;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Builds the settlement tree for `entries` with every hex value lowercased and the values in
 * canonical (node, role) order. The root does not depend on input order (StandardMerkleTree sorts
 * leaves by hash), but `tree.dump()` lists values in input order, so two settlers who computed the
 * same scores would otherwise publish different bytes, and different IPFS CIDs, for the same
 * tree. Canonical order makes the dump, and therefore the CID, a function of the scores alone.
 */
export function buildEpochTree(contextUID: string, epoch: bigint, entries: ScoreEntry[]): EpochTree {
  const ctx = contextUID.toLowerCase();
  const values = entries
    .map((e) => [ctx, e.node.toLowerCase(), e.role.toLowerCase(), e.score.toString(), epoch.toString()])
    .sort((a, b) => cmp(a[1]!, b[1]!) || cmp(a[2]!, b[2]!));
  return StandardMerkleTree.of(values, EPOCH_LEAF_ENCODING);
}

/**
 * Parses a dumped tree from an untrusted source. `StandardMerkleTree.load` itself rejects values
 * that do not hash into the stored tree; this wraps every such failure in one SDK error.
 */
export function loadEpochTree(data: unknown): EpochTree {
  try {
    return StandardMerkleTree.load(data as Parameters<typeof StandardMerkleTree.load>[0]) as EpochTree;
  } catch (err) {
    throw new DriftValidationError(`DRIFT SDK: not a valid settlement tree: ${(err as Error).message}`, { cause: err });
  }
}

/**
 * Checks a tree that came from outside this process (a gateway, a file) before it is trusted:
 * internal consistency (every value hashes into the stored tree, which `validate` checks), the
 * settlement leaf encoding, and, when given, the committed root and that every leaf belongs to
 * the expected context and epoch. The root check is what makes a tree from an untrusted source
 * safe to use: any tree with the committed root yields only proofs the contract accepts.
 */
export function checkEpochTree(tree: EpochTree, expected: TreeExpectation = {}): EpochTree {
  try {
    tree.validate();
  } catch (err) {
    throw new DriftValidationError(`DRIFT SDK: not a valid settlement tree: ${(err as Error).message}`, { cause: err });
  }
  const encoding = tree.dump().leafEncoding;
  if (encoding.length !== EPOCH_LEAF_ENCODING.length || encoding.some((t, i) => t !== EPOCH_LEAF_ENCODING[i])) {
    throw new DriftValidationError(`DRIFT SDK: settlement tree has leaf encoding [${encoding.join(', ')}], expected [${EPOCH_LEAF_ENCODING.join(', ')}].`);
  }
  if (expected.root !== undefined && tree.root.toLowerCase() !== expected.root.toLowerCase()) {
    throw new DriftValidationError(`DRIFT SDK: settlement tree root ${tree.root} does not match the expected root ${expected.root}.`);
  }
  if (expected.contextUID !== undefined || expected.epoch !== undefined) {
    const ctx = expected.contextUID?.toLowerCase();
    for (const [, v] of tree.entries()) {
      if ((ctx !== undefined && v[0]!.toLowerCase() !== ctx) || (expected.epoch !== undefined && BigInt(v[4]!) !== expected.epoch)) {
        throw new DriftValidationError(`DRIFT SDK: settlement tree holds a leaf for context ${v[0]} epoch ${v[4]}, outside the expected epoch.`);
      }
    }
  }
  return tree;
}

/** Every leaf for `node` (one per role it holds), optionally narrowed to `role`. */
export function findLeaves(tree: EpochTree, node: string, role?: string): { value: string[]; proof: string[] }[] {
  const n = node.toLowerCase();
  const r = role?.toLowerCase();
  const out: { value: string[]; proof: string[] }[] = [];
  for (const [i, v] of tree.entries()) {
    if (v[1]!.toLowerCase() === n && (r === undefined || v[2]!.toLowerCase() === r)) {
      out.push({ value: v, proof: tree.getProof(i) });
    }
  }
  return out;
}
