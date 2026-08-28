// Trust-graph storage — where a viewer's subjective peer weights persist. Import from
// '@drift-network/sdk/trust' rather than the package root.
//
// LocalTrustStore is browser-only (backed by localStorage); NodeTrustStore is Node-only (backed
// by the filesystem). `Drift`'s constructor already picks the right one automatically at
// runtime — only reach for these directly if you need a custom storageDir, want to construct one
// ahead of time, or are implementing ITrustStore yourself.
export { LocalTrustStore } from './LocalTrustStore.js';
export type { TrustGraph } from './LocalTrustStore.js';

export { NodeTrustStore } from './NodeTrustStore.js';

export type { ITrustStore } from './ITrustStore.js';
