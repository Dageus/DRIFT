import * as fs from 'fs';
import * as path from 'path';
import { isHexString } from 'ethers';
import type { IMerkleStore } from '@drift-network/sdk/merkle';
import { checkEpochTree, findLeaves, loadEpochTree, type EpochTree } from '@drift-network/sdk/merkle';
import { DriftNotFoundError, DriftValidationError } from '@drift-network/sdk';

export class LocalTreeStore implements IMerkleStore {
  private readonly baseDir: string;

  constructor(storageDir: string = './drift-trees') {
    this.baseDir = storageDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /** contextUID is part of the file name, so it must be exactly a bytes32 hex string. */
  private _file(contextUID: string, epoch: bigint): string {
    if (!isHexString(contextUID, 32)) {
      throw new DriftValidationError(`DRIFT SDK: contextUID must be a 32-byte hex string, got ${contextUID}.`);
    }
    return path.join(this.baseDir, `${contextUID.toLowerCase()}_epoch_${epoch}.json`);
  }

  public async saveTree(contextUID: string, epoch: bigint, tree: EpochTree): Promise<void> {
    await fs.promises.writeFile(this._file(contextUID, epoch), JSON.stringify(tree.dump(), null, 2));
  }

  /** Loads and checks the tree: a file on disk is input like any other. */
  public async loadTree(contextUID: string, epoch: bigint): Promise<EpochTree> {
    const filename = this._file(contextUID, epoch);
    let raw: string;
    try {
      raw = await fs.promises.readFile(filename, 'utf-8');
    } catch {
      throw new DriftNotFoundError(`DRIFT SDK: Tree not found for context ${contextUID} at epoch ${epoch}`);
    }
    return checkEpochTree(loadEpochTree(JSON.parse(raw)), { contextUID, epoch });
  }

  public async loadLeaves(contextUID: string, epoch: bigint, node: string): Promise<string[][]> {
    return findLeaves(await this.loadTree(contextUID, epoch), node).map((l) => l.value);
  }

  public async loadLeaf(contextUID: string, epoch: bigint, node: string, role?: string): Promise<string[]> {
    const leaves = findLeaves(await this.loadTree(contextUID, epoch), node, role);
    if (leaves.length === 0) {
      throw new DriftNotFoundError(
        `DRIFT SDK: Leaf not found for node ${node}${role ? ` role ${role}` : ''} in context ${contextUID} at epoch ${epoch}`
      );
    }
    if (leaves.length > 1) {
      throw new DriftValidationError(
        `DRIFT SDK: node ${node} holds ${leaves.length} roles at epoch ${epoch}; pass the role to loadLeaf, or use loadLeaves.`
      );
    }
    return leaves[0]!.value;
  }
}
