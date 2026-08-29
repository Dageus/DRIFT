/**
 * Practical example: what actually happens to `treeURI`.
 *
 * `postEpochRoot(epoch, merkleRoot, treeURI, sig)` and the `EpochRootPosted` event both carry
 * `treeURI`, but the contract never stores or dereferences it — it's a pointer the settler hands
 * out and a claimant is expected to resolve themselves. Until now the SDK had no adapter that
 * actually did that resolution; this script is the concrete, runnable demonstration of the round
 * trip using `IPFSTreeTransport` (`@drift-network/sdk/merkle`):
 *
 *   1. Build a small epoch's worth of scores into a StandardMerkleTree (the same shape
 *      DriftSettler.buildAndSignEpochRoot produces: [contextUID, node, role, score, epoch]).
 *   2. Upload it via IPFSTreeTransport.uploadTree — this is exactly the `uploader` callback
 *      buildAndSignEpochRoot expects, so in a real settler this step slots in directly:
 *        settler.buildAndSignEpochRoot(client, contextUID, epoch, scores, transport.uploadTree.bind(transport))
 *   3. Simulate what a claimant sees on-chain: just the `treeURI` string (from the
 *      EpochRootPosted event) and the committed root (from postEpochRoot/epochRoots).
 *   4. Resolve that treeURI back into a tree via IPFSTreeTransport.fetchTree — note this does NOT
 *      reuse the in-memory `tree` from step 1 anywhere; it re-fetches from IPFS to prove the round
 *      trip actually works over the network, not just in process memory.
 *   5. Confirm the fetched tree's root matches the committed root, then extract and independently
 *      verify one claimant's proof from it — the exact proof they'd submit to claimReputation.
 *
 * What this does NOT cover: actually calling postEpochRoot/claimReputation on a deployed
 * WeightedGovernanceClient (that needs a funded signer and a live chain — see
 * test/scenarios/governance.ts, and TODO.md's note on why that script isn't yet a clean
 * copy-pasteable example itself).
 *
 * Prerequisites — one of:
 *   - A local Kubo node: `ipfs daemon` (defaults below assume http://127.0.0.1:5001).
 *   - Any Kubo-compatible pinning service: set IPFS_API_URL (and IPFS_API_AUTH if it requires a
 *     bearer token) to its API endpoint.
 *
 * Run: npx tsx examples/treeuri-ipfs.ts   (or: npm run build && node dist-examples/...)
 */
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { Wallet } from 'ethers';
import { IPFSTreeTransport } from '../src/merkle/index.js';
import { DriftSettler, type ScoreEntry } from '../src/settler.js';
import { contextUID as deriveContextUID, roleId } from '../src/utils.js';

async function main() {
  const apiUrl = process.env.IPFS_API_URL ?? 'http://127.0.0.1:5001';
  const gatewayUrl = process.env.IPFS_GATEWAY_URL; // defaults to https://ipfs.io inside the class
  const authorization = process.env.IPFS_API_AUTH;
  const transport = new IPFSTreeTransport({ apiUrl, gatewayUrl, authorization });

  const contextUID = deriveContextUID('examples.treeuri-ipfs');
  const role = roleId('MEMBER');
  const epoch = 1n;

  const alice = '0x1111111111111111111111111111111111111111';
  const bob = '0x2222222222222222222222222222222222222222';
  const scores: ScoreEntry[] = [
    { node: alice, role, score: 420n },
    { node: bob, role, score: 180n }
  ];

  // Step 1 — build the tree exactly as buildAndSignEpochRoot does internally.
  const values = scores.map((s) => [contextUID, s.node, s.role, s.score.toString(), epoch.toString()]);
  const tree = StandardMerkleTree.of(values, ['bytes32', 'address', 'bytes32', 'uint256', 'uint256']);
  console.log(`Built tree with ${scores.length} leaves. Root: ${tree.root}`);

  // Step 2 — publish it. This is the exact call buildAndSignEpochRoot's `uploader` param makes.
  console.log(`Uploading to IPFS via ${apiUrl} ...`);
  const treeURI = await transport.uploadTree(tree);
  console.log(`Uploaded. treeURI = ${treeURI}`);
  console.log(`(This is the string that goes into postEpochRoot's treeURI parameter and the`);
  console.log(` EpochRootPosted event — a claimant later reads it from chain, not from this process.)`);

  // Step 3 — what a claimant actually has after observing chain state: treeURI + committed root.
  const committedRoot = tree.root; // stand-in for epochRoots[epoch] read from the deployed client
  const observedTreeURI = treeURI; // stand-in for the EpochRootPosted event's treeURI field

  // Step 4 — resolve treeURI back into a tree. Deliberately not reusing `tree` from step 1: this
  // is a fresh fetch over the network, proving the round trip works for a claimant who never had
  // the tree in memory to begin with.
  console.log(`\nResolving treeURI back into a tree via the gateway ...`);
  const fetchedTree = await transport.fetchTree(observedTreeURI);

  // Step 5 — integrity check, then extract and verify one claimant's proof.
  if (fetchedTree.root !== committedRoot) {
    throw new Error('Fetched tree root does not match the committed root — integrity check failed.');
  }
  console.log(`Fetched tree root matches the committed root: ${fetchedTree.root}`);

  const settler = new DriftSettler(Wallet.createRandom()); // offline signer — only used for the
  // pure tree-scanning helper below, no provider/chain interaction happens.
  const alicePayload = settler.generateProofOfStatePayload(fetchedTree, contextUID, alice, epoch);

  const leafIndex = Array.from(fetchedTree.entries()).find(
    ([, v]) => v[1]?.toLowerCase() === alice.toLowerCase()
  )?.[0];
  if (leafIndex === undefined) throw new Error('Leaf not found');
  const verified = StandardMerkleTree.verify(
    fetchedTree.root,
    ['bytes32', 'address', 'bytes32', 'uint256', 'uint256'],
    [contextUID, alice, role, '420', epoch.toString()],
    alicePayload.proofs[0]!
  );

  console.log(`\nAlice's proof, extracted from the IPFS-fetched tree, verifies: ${verified}`);
  console.log(`Depth: ${alicePayload.proofs[0]!.length}, this is exactly what claimReputation(...) needs.`);
}

main().catch((err) => {
  console.error('\nFailed:', err.message ?? err);
  console.error('\nIs an IPFS API reachable? Try `ipfs daemon` locally, or set IPFS_API_URL to a pinning service.');
  process.exitCode = 1;
});
