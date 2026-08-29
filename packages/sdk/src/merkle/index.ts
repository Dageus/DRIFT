// Merkle tree storage — persists the settler's full tree so proofs can be reconstructed client
// side. Import from '@drift-network/sdk/merkle' rather than the package root.
//
// Node-only (LocalTreeStore is backed by the filesystem) — this is settler/oracle-side tooling,
// not something a wallet-connected browser dApp should import.
export { LocalTreeStore } from './LocalTreeStore.js';
export type { IMerkleStore } from './IMerkleStore.js';

// treeURI transport — publishes/resolves the tree postEpochRoot's treeURI field points at.
// IPFSTreeTransport uses global fetch/FormData/Blob only, so it works in Node or a browser.
export { IPFSTreeTransport } from './IPFSTreeTransport.js';
export type { IPFSTreeTransportConfig } from './IPFSTreeTransport.js';
export type { ITreeTransport } from './ITreeTransport.js';
