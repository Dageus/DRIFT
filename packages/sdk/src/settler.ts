import { Signer, Contract, TypedDataDomain } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';

const EIP712_ABI = [
  'function eip712Domain() external view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)'
];

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
   * Build a Merkle tree from off-chain scores and sign the root.
   * Directly matches EVM double-hashing: keccak256(bytes.concat(keccak256(abi.encode(...))))
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
      throw new Error(`DRIFT SDK: No reputation claims found for node ${node} at epoch ${epoch}`);
    }

    return { roles, scores, proofs };
  }

  private async _fetchDomain(contractAddress: string): Promise<TypedDataDomain> {
    const provider = this.signer.provider;
    if (!provider) throw new Error('DRIFT SDK: Signer must have a provider to fetch EIP-712 domain.');

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
