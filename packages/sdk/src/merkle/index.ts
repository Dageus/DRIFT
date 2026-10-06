// Settlement trees: canonical construction, checking, resolution from chain state, and transport.
// Import from '@drift-network/sdk/merkle'. The filesystem tree store a settler keeps is in
// @drift-network/operator (LocalTreeStore); IMerkleStore is the interface it implements.
export type { IMerkleStore } from './IMerkleStore.js';

// Canonical construction and checking of settlement trees.
export { EPOCH_LEAF_ENCODING, buildEpochTree, checkEpochTree, findLeaves, loadEpochTree } from './epochTree.js';
export type { EpochTree, TreeExpectation } from './epochTree.js';

// treeURI transport — publishes/resolves the tree postEpochRoot's treeURI field points at.
// IPFSTreeTransport uses global fetch/FormData/Blob only, so it works in Node or a browser.
export { IPFSTreeTransport } from './IPFSTreeTransport.js';
export type { IPFSTreeTransportConfig } from './IPFSTreeTransport.js';
export type { ITreeTransport } from './ITreeTransport.js';

// Chain state to a checked tree: committed root, EpochRootPosted event, fetch.
export { resolveEpochTree } from './resolveEpochTree.js';
export type { ResolvedEpochTree } from './resolveEpochTree.js';
