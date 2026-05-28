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
    if (!signer.provider) {
      throw new Error('DriftSettler: Signer must be connected to a provider.');
    }
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

    // WARNING: what if the user is new? he might not have records yet
    if (records.length === 0) {
      throw new Error('DriftSettler: No valid attestations found for this user.');
    }

    // NOTE: alternative
    // const score = records.length === 0 ? 0n : engine.calculateScore(records);

    const score = engine.calculateScore(records);

    const signature = await this._signPayload(clientAddress, contextUID, role, userAddress, score, epoch);

    return { score, signature };
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
