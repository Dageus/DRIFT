import * as fs from 'fs';
import * as path from 'path';
import { ITrustStore } from './ITrustStore.js';
import type { TrustGraph } from './LocalTrustStore.js';

const CURRENT_VERSION = 1;

/**
 * Filesystem-backed trust graph storage for Node/server-side SDK use, where `localStorage`
 * (LocalTrustStore's backing store) does not exist. One JSON file per viewer under `storageDir`,
 * mirroring LocalTreeStore's persistence pattern for Merkle trees (packages/sdk/src/merkle).
 *
 * Unlike LocalTrustStore, filesystem errors are not swallowed: a server process that can't
 * persist trust weights should fail loudly rather than silently losing them.
 */
export class NodeTrustStore implements ITrustStore {
  private readonly baseDir: string;
  private cache: Map<string, Map<string, number>> = new Map();

  constructor(storageDir: string = './drift-trust') {
    this.baseDir = storageDir;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  async getWeights(viewerAddress: string): Promise<Map<string, number>> {
    const vKey = viewerAddress.toLowerCase();

    if (this.cache.has(vKey)) {
      return new Map(this.cache.get(vKey)!);
    }

    let weights: Record<string, number> = {};
    const filePath = this._filePath(vKey);
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TrustGraph;
      if (parsed.version === CURRENT_VERSION) {
        weights = parsed.weights[vKey] ?? {};
      }
    }

    const map = new Map(Object.entries(weights));
    this.cache.set(vKey, map);
    return new Map(map);
  }

  async setWeight(viewerAddress: string, attesterAddress: string, weight: number): Promise<void> {
    const vKey = viewerAddress.toLowerCase();
    const aKey = attesterAddress.toLowerCase();
    const clamped = Math.max(0, Math.min(10000, weight));

    if (!this.cache.has(vKey)) {
      this.cache.set(vKey, new Map());
    }
    this.cache.get(vKey)!.set(aKey, clamped);

    this._persist(vKey);
  }

  async removeWeight(viewerAddress: string, attesterAddress: string): Promise<void> {
    const vKey = viewerAddress.toLowerCase();
    const aKey = attesterAddress.toLowerCase();

    this.cache.get(vKey)?.delete(aKey);
    this._persist(vKey);
  }

  async clear(viewerAddress: string): Promise<void> {
    const vKey = viewerAddress.toLowerCase();
    this.cache.delete(vKey);

    const filePath = this._filePath(vKey);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /**
   * Export trust graph as JSON
   */
  exportGraph(viewerAddress: string): string {
    const vKey = viewerAddress.toLowerCase();
    const weights = Object.fromEntries(this.cache.get(vKey) ?? new Map());
    return JSON.stringify({ weights: { [vKey]: weights }, version: CURRENT_VERSION }, null, 2);
  }

  private _filePath(vKey: string): string {
    return path.join(this.baseDir, `${vKey}.json`);
  }

  private _persist(vKey: string): void {
    const weights = Object.fromEntries(this.cache.get(vKey) ?? new Map());
    const graph: TrustGraph = { weights: { [vKey]: weights }, version: CURRENT_VERSION };
    fs.writeFileSync(this._filePath(vKey), JSON.stringify(graph, null, 2));
  }
}
