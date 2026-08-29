import type { StandardMerkleTree } from '@openzeppelin/merkle-tree';

/**
 * Publishes and retrieves a settled epoch's full Merkle tree via `treeURI` — the field
 * `postEpochRoot`/`EpochRootPosted` carry on-chain but never store or resolve themselves
 * (`WeightedGovernance.sol` only emits it; nothing dereferences it). `IMerkleStore` persists a
 * tree the settler already has in memory; this is the other half — going from a `treeURI` string
 * observed on-chain back to a tree a claimant can generate a proof from. `uploadTree`'s signature
 * matches `DriftSettler.buildAndSignEpochRoot`'s `uploader` parameter directly.
 */
export interface ITreeTransport {
  /** Publishes `tree` to the backing store and returns the `treeURI` to post on-chain. */
  uploadTree(tree: StandardMerkleTree<string[]>): Promise<string>;
  /** Resolves a `treeURI` (as observed from an `EpochRootPosted` event) into a usable tree. */
  fetchTree(treeURI: string): Promise<StandardMerkleTree<string[]>>;
}
