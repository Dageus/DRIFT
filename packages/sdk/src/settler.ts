import { Signer, Contract, TypedDataDomain } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { DriftError, DriftConfigError, DriftNotFoundError } from './errors.js';

const EIP712_ABI = [
  'function eip712Domain() external view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)'
];

const EPOCH_BOUNDARY_ABI = [
  'function epochLength() external view returns (uint256)',
  'function epochAnchorBlock() external view returns (uint256)'
];

/**
 * Thrown by assertSynchronizedForEpoch when the connected provider's observed chain head has not
 * yet reached the epoch's on-chain boundary block (h_0 + beta * epoch). Settlement must be
 * deferred, not retried against stale/incomplete data (O1).
 */
export class EpochNotSynchronizedError extends DriftError {
  constructor(
    public readonly observedHead: bigint,
    public readonly boundaryBlock: bigint
  ) {
    super(
      `DRIFT SDK: observed chain head (block ${observedHead}) has not reached the epoch boundary block ${boundaryBlock} yet — defer settlement.`
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
   * O1 synchronization check: computes the on-chain boundary block for `epoch`
   * (epochAnchorBlock + epochLength * epoch) and compares it to the connected provider's
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
  ): Promise<{ synced: boolean; observedHead: bigint; boundaryBlock: bigint }> {
    const provider = this.signer.provider;
    if (!provider) {
      throw new DriftConfigError('DRIFT SDK: Signer must have a provider to check epoch synchronization.');
    }

    const [{ epochLength, epochAnchorBlock }, observedHeadNum] = await Promise.all([
      this._fetchEpochBoundaryConfig(clientAddress),
      provider.getBlockNumber()
    ]);

    const boundaryBlock = epochAnchorBlock + epochLength * epoch;
    const observedHead = BigInt(observedHeadNum);

    return { synced: observedHead >= boundaryBlock, observedHead, boundaryBlock };
  }

  private async _fetchEpochBoundaryConfig(
    clientAddress: string
  ): Promise<{ epochLength: bigint; epochAnchorBlock: bigint }> {
    const contract = new Contract(clientAddress, EPOCH_BOUNDARY_ABI, this.signer.provider);
    const [epochLength, epochAnchorBlock] = await Promise.all([
      contract.epochLength(),
      contract.epochAnchorBlock()
    ]);
    return { epochLength: BigInt(epochLength), epochAnchorBlock: BigInt(epochAnchorBlock) };
  }

  /**
   * Convenience wrapper around isSynchronizedForEpoch that throws EpochNotSynchronizedError
   * instead of returning a boolean — for callers that want to fail fast rather than branch.
   */
  public async assertSynchronizedForEpoch(clientAddress: string, epoch: bigint): Promise<void> {
    const { synced, observedHead, boundaryBlock } = await this.isSynchronizedForEpoch(clientAddress, epoch);
    if (!synced) throw new EpochNotSynchronizedError(observedHead, boundaryBlock);
  }

  /**
   * Build a Merkle tree from off-chain scores and sign the root.
   * Directly matches EVM double-hashing: keccak256(bytes.concat(keccak256(abi.encode(...))))
   *
   * Does NOT perform the O1 synchronization check itself — call
   * isSynchronizedForEpoch/assertSynchronizedForEpoch before computing Phi_c for `epoch` and
   * invoking this method.
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
    const roles: string[] = [];
    const scores: bigint[] = [];
    const proofs: string[][] = [];

    for (const [i, v] of tree.entries()) {
      // v[0] = contextUID, v[1] = node, v[2] = role, v[3] = score, v[4] = epoch
      if (v[0] === contextUID && v[1].toLowerCase() === node.toLowerCase() && BigInt(v[4]) === epoch) {
        roles.push(v[2]);
        scores.push(BigInt(v[3]));
        proofs.push(tree.getProof(i));
      }
    }

    if (roles.length === 0) {
      throw new DriftNotFoundError(`DRIFT SDK: No reputation claims found for node ${node} at epoch ${epoch}`);
    }

    return { roles, scores, proofs };
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
      // v[0] = contextUID, v[1] = node, v[2] = role, v[3] = score, v[4] = epoch
      if (
        v[0] === contextUID &&
        v[1].toLowerCase() === node.toLowerCase() &&
        v[2] === role &&
        BigInt(v[4]) === epoch
      ) {
        return { score: BigInt(v[3]), proof: tree.getProof(i) };
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
    const d = await contract.eip712Domain();

    return {
      name: d.name,
      version: d.version,
      chainId: Number(d.chainId),
      verifyingContract: d.verifyingContract
    };
  }
}
