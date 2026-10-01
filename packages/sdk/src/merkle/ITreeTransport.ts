import type { EpochTree, TreeExpectation } from './epochTree.js';

/**
 * Publishes and retrieves a settled epoch's full Merkle tree via `treeURI`, the field
 * `postEpochRoot` and `EpochRootPosted` carry on-chain but never store or resolve themselves.
 * `IMerkleStore` persists a tree the settler already has in memory; this is the other half: going
 * from a `treeURI` observed on-chain back to a tree a claimant can build a proof from.
 * `uploadTree`'s signature matches `DriftSettler.buildAndSignEpochRoot`'s `uploader` parameter.
 */
export interface ITreeTransport {
  /** Publishes `tree` to the backing store and returns the `treeURI` to post on-chain. */
  uploadTree(tree: EpochTree): Promise<string>;
  /**
   * Resolves a `treeURI` into a tree and checks it with `checkEpochTree`. Pass the on-chain root
   * in `expected`: the transport is not trusted, the root is.
   */
  fetchTree(treeURI: string, expected?: TreeExpectation): Promise<EpochTree>;
  /** Keeps `treeURI` available from this transport's backing store, where that is meaningful. */
  pin?(treeURI: string): Promise<void>;
}
