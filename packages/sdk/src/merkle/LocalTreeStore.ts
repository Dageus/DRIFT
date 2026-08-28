import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import * as fs from 'fs';
import * as path from 'path';
import { IMerkleStore } from './IMerkleStore.js';

export class LocalTreeStore implements IMerkleStore {
  private baseDir: string;

  constructor(storageDir: string = './drift-trees') {
    this.baseDir = storageDir;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public async saveTree(contextUID: string, epoch: bigint, tree: StandardMerkleTree<string[]>): Promise<void> {
    const filename = path.join(this.baseDir, `${contextUID}_epoch_${epoch}.json`);
    fs.writeFileSync(filename, JSON.stringify(tree.dump(), null, 2));
  }

  public async loadTree(contextUID: string, epoch: bigint): Promise<StandardMerkleTree<string[]>> {
    const filename = path.join(this.baseDir, `${contextUID}_epoch_${epoch}.json`);
    if (!fs.existsSync(filename)) {
      throw new Error(`Tree not found for context ${contextUID} at epoch ${epoch}`);
    }
    const data = JSON.parse(fs.readFileSync(filename, 'utf-8'));
    return StandardMerkleTree.load(data);
  }

  public async loadLeaf(contextUID: string, epoch: bigint, node: string): Promise<string[]> {
    const tree = await this.loadTree(contextUID, epoch);
    const nodeKey = node.toLowerCase();

    // v[0] = contextUID, v[1] = node, v[2] = role, v[3] = score, v[4] = epoch
    for (const [, v] of tree.entries()) {
      if (v[0] === contextUID && v[1].toLowerCase() === nodeKey) {
        return v;
      }
    }

    throw new Error(`Leaf not found for node ${node} in context ${contextUID} at epoch ${epoch}`);
  }
}
