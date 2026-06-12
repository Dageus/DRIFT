import { Signer, Provider, Contract, Interface } from 'ethers';
import IGovArtifact from '../../../contracts/out/IDRIFTGovernance.sol/IDRIFTGovernance.json';
import { handleContractError } from '../utils';

export class GovernanceModule {
  private readonly _signer?: Signer;
  private readonly _runner: Signer | Provider;
  private readonly _interface: Interface;

  constructor(signerOrProvider: Signer | Provider) {
    this._runner = signerOrProvider;
    this._signer = 'signMessage' in signerOrProvider ? (signerOrProvider as Signer) : undefined;
    this._interface = new Interface(IGovArtifact.abi);
  }

  private _requireSigner(): Signer {
    if (!this._signer) throw new Error('DRIFT SDK: Write operations require a connected signer.');
    return this._signer;
  }

  private _governanceClient(clientAddress: string): Contract {
    return new Contract(clientAddress, IGovArtifact.abi, this._runner);
  }

  // Write Operations ==========================================================

  public async createProposal(
    clientAddress: string,
    description: string,
    target: string,
    payload: string,
    durationDays: number
  ): Promise<bigint> {
    try {
      const gc = this._governanceClient(clientAddress).connect(this._requireSigner());
      const tx = await gc.createProposal(description, target, payload, durationDays);
      const receipt = await tx.wait();

      const log = receipt.logs
        .map((l: any) => {
          try {
            return this._interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === 'ProposalCreated');

      if (!log) throw new Error('DRIFT SDK: ProposalCreated event not found in receipt.');
      return BigInt(log.args.proposalId);
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async castVote(clientAddress: string, proposalId: bigint, support: boolean): Promise<void> {
    try {
      const tx = await this._governanceClient(clientAddress)
        .connect(this._requireSigner())
        .castVote(proposalId, support);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async executeProposal(clientAddress: string, proposalId: bigint): Promise<void> {
    try {
      const tx = await this._governanceClient(clientAddress).connect(this._requireSigner()).executeProposal(proposalId);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  // Read Operations ===========================================================

  public async getVotingPower(clientAddress: string, account: string): Promise<bigint> {
    try {
      return BigInt(await this._governanceClient(clientAddress).getVotingPower(account));
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async hasVoted(clientAddress: string, proposalId: bigint | number, account: string): Promise<boolean> {
    try {
      return await this._governanceClient(clientAddress).hasVoted(proposalId, account);
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }
}
