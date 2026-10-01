import type { EpochTree } from './epochTree.js';

export interface IMerkleStore {
  saveTree(contextUID: string, epoch: bigint, tree: EpochTree): Promise<void>;
  loadTree(contextUID: string, epoch: bigint): Promise<EpochTree>;
  /**
   * The leaf values for (`node`, `role`). `role` may be omitted only when the node holds exactly
   * one role in this epoch; otherwise the call is ambiguous and throws.
   */
  loadLeaf(contextUID: string, epoch: bigint, node: string, role?: string): Promise<string[]>;
  /** Every leaf of `node` in this epoch, one per role. */
  loadLeaves(contextUID: string, epoch: bigint, node: string): Promise<string[][]>;
}
