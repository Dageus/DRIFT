import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeTrustStore } from '../../src/trust/NodeTrustStore.js';

describe('NodeTrustStore (A7 — Node-compatible trust store fallback)', () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-trust-test-'));
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const viewer = '0x1111111111111111111111111111111111111111';
  const attesterA = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const attesterB = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  it('returns an empty map for a viewer with no stored weights', async () => {
    const store = new NodeTrustStore(storageDir);
    const weights = await store.getWeights(viewer);
    expect(weights.size).toBe(0);
  });

  it('persists a set weight to disk and survives a new store instance', async () => {
    const store = new NodeTrustStore(storageDir);
    await store.setWeight(viewer, attesterA, 7500);

    // A fresh instance must read the weight back from the filesystem, not from in-memory cache —
    // this is the guarantee LocalTrustStore cannot make under Node (localStorage undefined).
    const reloaded = new NodeTrustStore(storageDir);
    const weights = await reloaded.getWeights(viewer);
    expect(weights.get(attesterA.toLowerCase())).toBe(7500);
  });

  it('clamps weights to [0, 10000]', async () => {
    const store = new NodeTrustStore(storageDir);
    await store.setWeight(viewer, attesterA, 99999);
    await store.setWeight(viewer, attesterB, -50);

    const weights = await store.getWeights(viewer);
    expect(weights.get(attesterA.toLowerCase())).toBe(10000);
    expect(weights.get(attesterB.toLowerCase())).toBe(0);
  });

  it('removes a weight', async () => {
    const store = new NodeTrustStore(storageDir);
    await store.setWeight(viewer, attesterA, 5000);
    await store.removeWeight(viewer, attesterA);

    const reloaded = new NodeTrustStore(storageDir);
    const weights = await reloaded.getWeights(viewer);
    expect(weights.has(attesterA.toLowerCase())).toBe(false);
  });

  it('clears all weights for a viewer and removes the backing file', async () => {
    const store = new NodeTrustStore(storageDir);
    await store.setWeight(viewer, attesterA, 5000);
    await store.clear(viewer);

    const filePath = path.join(storageDir, `${viewer.toLowerCase()}.json`);
    expect(fs.existsSync(filePath)).toBe(false);

    const reloaded = new NodeTrustStore(storageDir);
    const weights = await reloaded.getWeights(viewer);
    expect(weights.size).toBe(0);
  });

  it('creates the storage directory if it does not already exist', () => {
    const nestedDir = path.join(storageDir, 'nested', 'dir');
    expect(fs.existsSync(nestedDir)).toBe(false);

    new NodeTrustStore(nestedDir);
    expect(fs.existsSync(nestedDir)).toBe(true);
  });
});
