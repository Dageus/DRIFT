import { ITrustStore } from "./ITrustStore";

/**
 * Persistent local trust graph storage.
 *
 * Each viewer maintains their own subjective trust weights for attesters.
 */
export interface TrustGraph {
  weights: Record<string, Record<string, number>>;
  version: number;
}

const STORAGE_KEY = 'drift.trust.graph';
const CURRENT_VERSION = 1;

export class LocalTrustStore implements ITrustStore {
  private cache: Map<string, Map<string, number>> = new Map();

  /**
   * Load the viewer's trust weights from persistent storage.
   */
  getWeights(viewerAddress: string): Map<string, number> {
    const key = viewerAddress.toLowerCase();

    // Check memory cache first
    if (this.cache.has(key)) {
      return new Map(this.cache.get(key)!);
    }

    // Try localStorage (browser only)
    let weights: Record<string, number> = {};
    try {
      const raw = localStorage.getItem(`${STORAGE_KEY}.${key}`);
      if (raw) {
        const parsed = JSON.parse(raw) as TrustGraph;
        if (parsed.version === CURRENT_VERSION) {
          weights = parsed.weights[key] ?? {};
        }
      }
    } catch {
    }

    const map = new Map(Object.entries(weights));
    this.cache.set(key, map);
    return new Map(map);
  }

  /**
   * Set a single trust weight for a viewer→attester pair.
   * @param weight 0-10000 (0 = no trust, 10000 = maximum trust)
   */
  setWeight(viewerAddress: string, attesterAddress: string, weight: number): void {
    const vKey = viewerAddress.toLowerCase();
    const aKey = attesterAddress.toLowerCase();
    const clamped = Math.max(0, Math.min(10000, weight));

    // Update cache
    if (!this.cache.has(vKey)) {
      this.cache.set(vKey, new Map());
    }
    this.cache.get(vKey)!.set(aKey, clamped);

    // Persist
    this._persist(vKey);
  }

  /**
   * Set multiple weights at once (e.g., imported from a file or QR code).
   */
  setWeights(viewerAddress: string, weights: Record<string, number>): void {
    const vKey = viewerAddress.toLowerCase();
    const map = new Map<string, number>();

    for (const [attester, weight] of Object.entries(weights)) {
      map.set(attester.toLowerCase(), Math.max(0, Math.min(10000, weight)));
    }

    this.cache.set(vKey, map);
    this._persist(vKey);
  }

  /**
   * Remove a trust relationship.
   */
  removeWeight(viewerAddress: string, attesterAddress: string): void {
    const vKey = viewerAddress.toLowerCase();
    const aKey = attesterAddress.toLowerCase();

    this.cache.get(vKey)?.delete(aKey);
    this._persist(vKey);
  }

  /**
   * Reset all trust weights for a viewer.
   */
  clear(viewerAddress: string): void {
    const vKey = viewerAddress.toLowerCase();
    this.cache.delete(vKey);
    try {
      localStorage.removeItem(`${STORAGE_KEY}.${vKey}`);
    } catch {
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

  /**
   * Import trust graph from JSON.
   */
  importGraph(viewerAddress: string, json: string): void {
    const parsed = JSON.parse(json) as TrustGraph;
    if (parsed.version !== CURRENT_VERSION) {
      throw new Error(`Trust graph version mismatch: ${parsed.version} != ${CURRENT_VERSION}`);
    }
    const vKey = viewerAddress.toLowerCase();
    const weights = parsed.weights[vKey];
    if (weights) {
      this.setWeights(viewerAddress, weights);
    }
  }

  private _persist(vKey: string): void {
    try {
      const weights = Object.fromEntries(this.cache.get(vKey) ?? new Map());
      const graph: TrustGraph = { weights: { [vKey]: weights }, version: CURRENT_VERSION };
      localStorage.setItem(`${STORAGE_KEY}.${vKey}`, JSON.stringify(graph));
    } catch {
      // localStorage unavailable
    }
  }
}
