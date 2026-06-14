import { Signer, Provider, Contract, Interface, AbiCoder, keccak256 } from 'ethers';
import SettlerArtifact from '../../../contracts/out/IDRIFTSettler.sol/IDRIFTSettler.json';
import { handleContractError } from '../utils';

export class ReputationModule {
  private readonly _signer?: Signer;
  private readonly _runner: Signer | Provider;
  private readonly _interface: Interface;

  constructor(signerOrProvider: Signer | Provider) {
    this._runner = signerOrProvider;
    this._signer = 'signMessage' in signerOrProvider ? (signerOrProvider as Signer) : undefined;
    this._interface = new Interface(SettlerArtifact.abi);
  }

  private _requireSigner(): Signer {
    if (!this._signer) throw new Error('DRIFT SDK: Write operations require a connected signer.');
    return this._signer;
  }

  private _reputationClient(clientAddress: string): Contract {
    return new Contract(clientAddress, SettlerArtifact.abi, this._runner);
  }

  // Settlements & Configuration ===============================================

  public async settleReputation(
    clientAddress: string,
    node: string,
    role: string,
    score: bigint,
    epoch: bigint,
    signature: string
  ): Promise<void> {
    try {
      const tx = await this._reputationClient(clientAddress)
        .connect(this._requireSigner())
        .settleReputation(node, role, score, epoch, signature);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async settleReputationBatch(
    clientAddress: string,
    nodes: string[],
    roles: string[],
    scores: bigint[],
    epoch: bigint[],
    signatures: string[]
  ): Promise<void> {
    try {
      const tx = await this._reputationClient(clientAddress)
        .connect(this._requireSigner())
        .settleReputationBatch(nodes, roles, scores, epoch, signatures);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async fetchAndSettle(
    clientAddress: string,
    contextUID: string,
    userAddress: string,
    role: string,
    endpointUrl: string
  ): Promise<void> {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextUID, userAddress, role })
    });

    if (!response.ok) {
      throw new Error(`DRIFT SDK: Settlement fetch failed with status ${response.status}`);
    }

    const { score, epoch, signature } = await response.json();

    await this.settleReputation(clientAddress, userAddress, role, BigInt(score), BigInt(epoch), signature);
  }

  public async setTrustedSettler(clientAddress: string, newSettler: string): Promise<void> {
    try {
      const tx = await this._reputationClient(clientAddress)
        .connect(this._requireSigner())
        .setTrustedSettler(newSettler);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  // Read Operations ===========================================================

  public async getReputationBalance(
    tokenAddress: string,
    account: string,
    contextUID: string,
    role: string
  ): Promise<bigint> {
    try {
      const token = new Contract(
        tokenAddress,
        ['function balanceOf(address account, uint256 id) external view returns (uint256)'],
        this._runner
      );

      const tokenId = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [contextUID, role]));
      return BigInt(await token.balanceOf(account, tokenId));
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }
}
