// Merkle tree storage — persists the settler's full tree so proofs can be reconstructed client
// side. Import from '@drift-network/sdk/merkle' rather than the package root.
//
// Node-only (LocalTreeStore is backed by the filesystem) — this is settler/oracle-side tooling,
// not something a wallet-connected browser dApp should import.
export { LocalTreeStore } from './LocalTreeStore.js';
export type { IMerkleStore } from './IMerkleStore.js';
