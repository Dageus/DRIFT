import { Signer, Contract, TypedDataDomain } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { DriftError, DriftConfigError, DriftNotFoundError, DriftValidationError } from './errors.js';

const EIP712_ABI = [
  'function eip712Domain() external view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)'
];

const EPOCH_BOUNDARY_ABI = [
  'function epochLength() external view returns (uint256)',
  'function epochAnchorTimestamp() external view returns (uint256)'
];

const CLIENT_REGISTRY_ABI = [
  'function core() external view returns (address)',
  'function contextUID() external view returns (bytes32)'
];

const HELD_ROLE_AT_ABI = [
  'function nodeHeldRoleAt(bytes32 contextUID, address node, bytes32 role, uint256 timestamp) external view returns (bool)'
];

/**
 * Thrown by assertSynchronizedForEpoch when the connected provider's observed chain head has not
 * yet reached the epoch's on-chain boundary timestamp (t_0 + beta * epoch). Settlement must be
 * deferred, not retried against stale/incomplete data (O1).
 *
 * Timestamps, not block numbers: block.number is not portable across the chains this protocol
 * targets (Arbitrum reflects L1 block numbers with irregular L2 spacing; Polygon produces blocks
 * at a different rate again), while block.timestamp is seconds everywhere.
 */
export class EpochNotSynchronizedError extends DriftError {
  constructor(
    public readonly observedHead: bigint,
    public readonly boundaryTimestamp: bigint
  ) {
    super(
      `DRIFT SDK: observed chain head (timestamp ${observedHead}) has not reached the epoch boundary timestamp ${boundaryTimestamp} yet — defer settlement.`
    );
  }
}

const SETTLE_ROOT_TYPES = {
  SettleRoot: [
    { name: 'contextUID', type: 'bytes32' },
    { name: 'epoch', type: 'uint256' },
    { name: 'merkleRoot', type: 'bytes32' },
    { name: 'treeURI', type: 'string' }
  ]
};

export interface ScoreEntry {
  node: string;
  role: string;
  score: bigint;
}

export interface ProofOfStatePayload {
  roles: string[];
  scores: bigint[];
  proofs: string[][];
}

export class DriftSettler {
  public readonly signer: Signer;

  constructor(signer: Signer) {
    this.signer = signer;
  }

  /**
   * O1 synchronization check: computes the on-chain boundary timestamp for `epoch`
   * (epochAnchorTimestamp + epochLength * epoch) and compares it to the connected provider's
   * currently observed chain head. This repo does not yet ship a dedicated indexer/subgraph
   * (see TODO.md), so the RPC provider's head is used as an interim proxy for "the indexer's
   * observed head" the thesis's O1 assumption describes.
   *
   * Callers computing Phi_c for `epoch` MUST check this (or use assertSynchronizedForEpoch)
   * BEFORE fetching attestations and calling buildAndSignEpochRoot — this method intentionally
   * does not gate buildAndSignEpochRoot itself, so tree-building/signing stays unit-testable
   * against an offline signer with no provider attached.
   */
  public async isSynchronizedForEpoch(
    clientAddress: string,
    epoch: bigint
  ): Promise<{ synced: boolean; observedHead: bigint; boundaryTimestamp: bigint }> {
    const provider = this.signer.provider;
    if (!provider) {
      throw new DriftConfigError('DRIFT SDK: Signer must have a provider to check epoch synchronization.');
    }

    const [{ epochLength, epochAnchorTimestamp }, latestBlock] = await Promise.all([
      this._fetchEpochBoundaryConfig(clientAddress),
      provider.getBlock('latest')
    ]);
    if (!latestBlock) {
      throw new DriftConfigError('DRIFT SDK: Provider returned no latest block.');
    }

    const boundaryTimestamp = epochAnchorTimestamp + epochLength * epoch;
    const observedHead = BigInt(latestBlock.timestamp);

    return { synced: observedHead >= boundaryTimestamp, observedHead, boundaryTimestamp };
  }

  private async _fetchEpochBoundaryConfig(
    clientAddress: string
  ): Promise<{ epochLength: bigint; epochAnchorTimestamp: bigint }> {
    const contract = new Contract(clientAddress, EPOCH_BOUNDARY_ABI, this.signer.provider);
    // Dynamic ABI method access — always present, EPOCH_BOUNDARY_ABI declares both.
    const [epochLength, epochAnchorTimestamp] = await Promise.all([
      contract.epochLength!(),
      contract.epochAnchorTimestamp!()
    ]);
    return { epochLength: BigInt(epochLength), epochAnchorTimestamp: BigInt(epochAnchorTimestamp) };
  }

  /**
   * Convenience wrapper around isSynchronizedForEpoch that throws EpochNotSynchronizedError
   * instead of returning a boolean — for callers that want to fail fast rather than branch.
   */
  public async assertSynchronizedForEpoch(clientAddress: string, epoch: bigint): Promise<void> {
    const { synced, observedHead, boundaryTimestamp } = await this.isSynchronizedForEpoch(clientAddress, epoch);
    if (!synced) throw new EpochNotSynchronizedError(observedHead, boundaryTimestamp);
  }

  /**
   * Checks, for every unique (node, role) pair in `scores`, that the node held the role at
   * `epoch`'s boundary, as DRIFTCore.nodeHeldRoleAt reports it. Throws DriftValidationError naming
   * the first pair that did not.
   *
   * The reference time is the boundary, not the present, and both directions matter. An epoch's
   * leaf set must be exactly the pairs that existed at its boundary: the dispute contract admits an
   * omission challenge for any such pair, so dropping one whose role was revoked after the boundary
   * lets that node win the settler's bond; and including one whose role was assigned after the
   * boundary would let a node vote on a snapshot with a role it acquired later.
   *
   * Callers computing Phi_c for `epoch` MUST check this. It intentionally does not gate
   * buildAndSignEpochRoot itself, so tree-building and signing stay unit-testable against an
   * offline signer with no provider attached, matching isSynchronizedForEpoch's convention.
   */
  public async assertRolesAssigned(clientAddress: string, epoch: bigint, scores: ScoreEntry[]): Promise<void> {
    if (!this.signer.provider) {
      throw new DriftConfigError('DRIFT SDK: Signer must have a provider to check role assignment.');
    }

    const seen = new Set<string>();
    const pairs = scores.filter((s) => {
      const key = `${s.node.toLowerCase()}:${s.role}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const { epochLength, epochAnchorTimestamp } = await this._fetchEpochBoundaryConfig(clientAddress);
    const boundary = epochAnchorTimestamp + epochLength * epoch;

    const results = await Promise.all(
      pairs.map((s) => this._fetchHeldRoleAt(clientAddress, s.node, s.role, boundary))
    );
    const missing = pairs.find((_, i) => !results[i]);
    if (missing) {
      throw new DriftValidationError(
        `DRIFT SDK: node ${missing.node} did not hold role ${missing.role} at the boundary of epoch ${epoch} ` +
          `in context at ${clientAddress}; only pairs held at the boundary may be settled.`
      );
    }
  }

  private async _fetchHeldRoleAt(
    clientAddress: string,
    node: string,
    role: string,
    timestamp: bigint
  ): Promise<boolean> {
    const client = new Contract(clientAddress, CLIENT_REGISTRY_ABI, this.signer.provider);
    // Dynamic ABI method access: both are declared in CLIENT_REGISTRY_ABI.
    const [coreAddress, contextUID] = await Promise.all([client.core!(), client.contextUID!()]);
    const core = new Contract(coreAddress, HELD_ROLE_AT_ABI, this.signer.provider);
    return await core.nodeHeldRoleAt!(contextUID, node, role, timestamp);
  }

  /**
   * Build a Merkle tree from off-chain scores and sign the root.
   * Directly matches EVM double-hashing: keccak256(bytes.concat(keccak256(abi.encode(...))))
   *
   * Does NOT perform the O1 synchronization check itself — call
   * isSynchronizedForEpoch/assertSynchronizedForEpoch before computing Phi_c for `epoch` and
   * invoking this method. Nor does it check role assignment itself — call assertRolesAssigned
   * first to confirm every `scores` entry names a pair held at the epoch boundary.
   */
  public async buildAndSignEpochRoot(
    clientAddress: string,
    contextUID: string,
    epoch: bigint,
    scores: ScoreEntry[],
    uploader: (tree: StandardMerkleTree<string[]>) => Promise<string>
  ): Promise<{ root: string; signature: string; tree: StandardMerkleTree<string[]>; treeURI: string }> {
    const values = scores.map((s) => [contextUID, s.node, s.role, s.score.toString(), epoch.toString()]);
    const tree = StandardMerkleTree.of(values, ['bytes32', 'address', 'bytes32', 'uint256', 'uint256']);

    // The tree must be uploaded to resolve the URI before computing the signature
    const treeURI = await uploader(tree);

    const domain = await this._fetchDomain(clientAddress);
    const signature = await this.signer.signTypedData(domain, SETTLE_ROOT_TYPES, {
      contextUID,
      epoch,
      merkleRoot: tree.root,
      treeURI
    });

    return { root: tree.root, signature, tree, treeURI };
  }

  /**
   * Scans the Merkle Tree to construct the parallel arrays required for Stateless Governance execution.
   */
  public generateProofOfStatePayload(
    tree: StandardMerkleTree<string[]>,
    contextUID: string,
    node: string,
    epoch: bigint
  ): ProofOfStatePayload {
    const entries: { role: string; score: bigint; proof: string[] }[] = [];

    for (const [i, v] of tree.entries()) {
      // v[0] = contextUID, v[1] = node, v[2] = role, v[3] = score, v[4] = epoch — always a 5-tuple.
      if (v[0] === contextUID && v[1]!.toLowerCase() === node.toLowerCase() && BigInt(v[4]!) === epoch) {
        entries.push({ role: v[2]!, score: BigInt(v[3]!), proof: tree.getProof(i) });
      }
    }

    if (entries.length === 0) {
      throw new DriftNotFoundError(`DRIFT SDK: No reputation claims found for node ${node} at epoch ${epoch}`);
    }

    // The client rejects roles that are not strictly increasing (a repeated role would count its
    // leaf twice), so emit them in ascending bytes32 order.
    entries.sort((a, b) => (BigInt(a.role) < BigInt(b.role) ? -1 : BigInt(a.role) > BigInt(b.role) ? 1 : 0));

    return {
      roles: entries.map((e) => e.role),
      scores: entries.map((e) => e.score),
      proofs: entries.map((e) => e.proof)
    };
  }

  /**
   * Finds the single leaf for (node, role) at `epoch` and returns exactly what
   * `respondToChallenge` (B1 non-inclusion disputes) needs: the leaf's score and inclusion proof.
   * Reuses the same tree-scanning logic as generateProofOfStatePayload rather than requiring any
   * new tree-construction machinery — the B1 leaf encoding is unchanged from the existing
   * H(c‖n‖r‖score‖E) scheme.
   */
  public generateChallengeResponse(
    tree: StandardMerkleTree<string[]>,
    contextUID: string,
    node: string,
    role: string,
    epoch: bigint
  ): { score: bigint; proof: string[] } {
    for (const [i, v] of tree.entries()) {
      // v[0] = contextUID, v[1] = node, v[2] = role, v[3] = score, v[4] = epoch — always a 5-tuple.
      if (
        v[0] === contextUID &&
        v[1]!.toLowerCase() === node.toLowerCase() &&
        v[2] === role &&
        BigInt(v[4]!) === epoch
      ) {
        return { score: BigInt(v[3]!), proof: tree.getProof(i) };
      }
    }

    throw new DriftNotFoundError(
      `DRIFT SDK: No leaf found for node ${node} role ${role} at epoch ${epoch} — cannot respond to challenge.`
    );
  }

  private async _fetchDomain(contractAddress: string): Promise<TypedDataDomain> {
    const provider = this.signer.provider;
    if (!provider) throw new DriftConfigError('DRIFT SDK: Signer must have a provider to fetch EIP-712 domain.');

    const contract = new Contract(contractAddress, EIP712_ABI, provider);
    // Dynamic ABI method access — always present, EIP712_ABI declares it.
    const d = await contract.eip712Domain!();

    return {
      name: d.name,
      version: d.version,
      chainId: Number(d.chainId),
      verifyingContract: d.verifyingContract
    };
  }
}
