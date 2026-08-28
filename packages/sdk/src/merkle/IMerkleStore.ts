import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

export interface IMerkleStore {
  saveTree(contextUID: string, epoch: bigint, tree: StandardMerkleTree<string[]>): Promise<void>;
  loadTree(contextUID: string, epoch: bigint): Promise<StandardMerkleTree<string[]>>;
  loadLeaf(contextUID: string, epoch: bigint, node: string): Promise<string[]>;
}
