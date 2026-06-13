import { Signer, Contract, isHexString, TypedDataDomain, TypedDataField } from 'ethers';
import { IAttestationProvider } from './providers/IAttestationProvider';
import { IReputationEngine } from './engines/IReputationEngine';

const EIP712_ABI = [
  'function eip712Domain() external view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)'
];

const SETTLE_TYPES: Record<string, TypedDataField[]> = {
  Settle: [
    { name: 'contextUID', type: 'bytes32' },
    { name: 'node', type: 'address' },
    { name: 'role', type: 'bytes32' },
    { name: 'score', type: 'uint256' },
    { name: 'epoch', type: 'uint256' }
  ]
};

export class DriftSettler {
  public readonly signer: Signer;

  constructor(signer: Signer) {
    this.signer = signer;
  }

  /**
   * Orchestrates the off-chain pipeline: Fetch -> Compute -> Sign.
   */
  public async generateSettlementSignature(
    clientAddress: string,
    contextUID: string,
    role: string,
    userAddress: string,
    epoch: bigint,
    provider: IAttestationProvider,
    engine: IReputationEngine
  ): Promise<{ score: bigint; signature: string }> {
    const records = await provider.fetchUserRecords(contextUID, userAddress);

    const score = records.length === 0 ? 0n : engine.calculateScore(records);

    const signature = await this._signPayload(clientAddress, contextUID, role, userAddress, score, epoch);

    return { score, signature };
  }

  /**
   * Orchestrates the off-chain pipeline for a batch of users.
   * Required for mass-settlement and global algorithms.
   */
  public async generateBatchSettlementSignatures(
    clientAddress: string,
    contextUID: string,
    role: string,
    userAddresses: string[],
    epoch: bigint,
    provider: IAttestationProvider,
    engine: IReputationEngine
  ): Promise<{ scores: bigint[]; signatures: string[] }> {
    // For global scaling, the provider should ideally fetch the entire context graph once.
    // If IAttestationProvider only has fetchUserRecords, it will bottleneck here.

    const scores: bigint[] = [];
    const signatures: string[] = [];

    // NOTE: If using EigenTrust, the engine should calculate the entire network matrix once
    // before this loop, rather than recalculating per user.
    for (const user of userAddresses) {
      const records = await provider.fetchUserRecords(contextUID, user);

      const score = records.length === 0 ? 0n : engine.calculateScore(records);
      const signature = await this._signPayload(clientAddress, contextUID, role, user, score, epoch);

      scores.push(score);
      signatures.push(signature);
    }

    return { scores, signatures };
  }

  /**
   * Dynamically fetches the EIP-712 domain and signs the settlement payload.
   */
  private async _signPayload(
    clientAddress: string,
    contextUID: string,
    role: string,
    node: string,
    score: bigint,
    epoch: bigint
  ): Promise<string> {
    this._validateBytes32(contextUID, 'contextUID');
    this._validateBytes32(role, 'role');

    const domain = await this._fetchDomain(clientAddress);

    return await this.signer.signTypedData(domain, SETTLE_TYPES, {
      contextUID,
      node,
      role,
      score,
      epoch
    });
  }

  // Private helpers ===========================================================

  private _validateBytes32(value: string, name: string): void {
    if (!isHexString(value, 32)) {
      throw new Error(
        `DRIFT SDK: '${name}' must be a 32-byte hex string (0x + 64 hex chars). Received: ${value}.\n` +
          `Hint: use ethers.id("ROLE_NAME") or ethers.keccak256(ethers.toUtf8Bytes("name")) to derive it.`
      );
    }
  }

  private async _fetchDomain(contractAddress: string): Promise<TypedDataDomain> {
    const provider = this.signer.provider;
    if (!provider) {
      throw new Error('DriftSettler: Signer must have a provider to fetch EIP-712 domain.');
    }
    const contract = new Contract(contractAddress, EIP712_ABI, this.signer.provider);
    const d = await contract.eip712Domain();
    return {
      name: d.name,
      version: d.version,
      chainId: Number(d.chainId),
      verifyingContract: d.verifyingContract
    };
  }
}
