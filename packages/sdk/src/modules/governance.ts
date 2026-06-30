import { Signer, Provider, Contract, Interface } from 'ethers';
import IGovArtifact from '../../../contracts/out/IDRIFTGovernanceProofOfState.sol/IDRIFTGovernanceProofOfState.json';
import { handleContractError } from '../utils';
import type { ProofOfStatePayload } from '../settler';

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

  private _governanceClient(clientAddress: string): any {
    return new Contract(clientAddress, IGovArtifact.abi, this._runner);
  }

  // Pre-flight Simulation =====================================================

  /**
   * Simulates voting power using a static call. Throws if proofs are cryptographically invalid.
   */
  public async simulateVotingPower(
    clientAddress: string,
    account: string,
    epoch: bigint,
    payload: ProofOfStatePayload
  ): Promise<bigint> {
    this._validatePayload(payload);
    try {
      const power = await this._governanceClient(clientAddress).getVotingPowerAtEpoch(
        account,
        epoch,
        payload.roles,
        payload.scores,
        payload.proofs
      );
      return BigInt(power);
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  // Proof-of-State Execution ==================================================

  public async createProposalWithProofs(
    clientAddress: string,
    description: string,
    target: string,
    callData: string,
    durationDays: number,
    payload: ProofOfStatePayload
  ): Promise<bigint> {
    this._validatePayload(payload);
    try {
      const gc = this._governanceClient(clientAddress).connect(this._requireSigner());
      const tx = await gc.createProposalWithProofs(
        description,
        target,
        callData,
        durationDays,
        payload.roles,
        payload.scores,
        payload.proofs
      );
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

  public async castVoteWithProofs(
    clientAddress: string,
    proposalId: bigint,
    support: boolean,
    payload: ProofOfStatePayload
  ): Promise<void> {
    this._validatePayload(payload);
    try {
      const tx = await this._governanceClient(clientAddress)
        .connect(this._requireSigner())
        .castVoteWithProofs(proposalId, support, payload.roles, payload.scores, payload.proofs);
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

  // Views =====================================================================

  public async hasVoted(clientAddress: string, proposalId: bigint | number, account: string): Promise<boolean> {
    try {
      return await this._governanceClient(clientAddress).hasVoted(proposalId, account);
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async getActiveRoles(clientAddress: string): Promise<string[]> {
    try {
      return await this._governanceClient(clientAddress).getActiveRoles();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async getProposal(clientAddress: string, proposalId: bigint) {
    try {
      const proposal = await this._governanceClient(clientAddress).getProposal(proposalId);
      return {
        description: proposal.description,
        target: proposal.target,
        payload: proposal.payload,
        votesFor: BigInt(proposal.votesFor),
        votesAgainst: BigInt(proposal.votesAgainst),
        deadline: BigInt(proposal.deadline),
        executed: proposal.executed,
        exists: proposal.exists
      };
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

/**
 * Retrieves the snapshot configuration for a proposal.
 * @param clientAddress The governance client contract address
 * @param proposalId The proposal ID
 * @returns snapshotEpoch and configVersion pinned at proposal creation
 */
public async getProposalSnapshot(
  clientAddress: string,
  proposalId: bigint
): Promise<{ snapshotEpoch: bigint; configVersion: number }> {
  try {
    const gc = this._governanceClient(clientAddress);
    const result = await gc.getProposalSnapshot(proposalId);
    return {
      snapshotEpoch: BigInt(result.snapshotEpoch),
      configVersion: Number(result.configVersion)
    };
  } catch (err) {
    handleContractError(err, this._interface);
  }
}

/**
 * Retrieves the weight for a role at a specific configuration version.
 * @param clientAddress The governance client contract address
 * @param configVersion The weight configuration version
 * @param role The role identifier
 * @returns The weight for the role at that version
 */
public async getWeightAtVersion(
  clientAddress: string,
  configVersion: number,
  role: string
): Promise<bigint> {
  try {
    const gc = this._governanceClient(clientAddress);
    const weight = await gc.getWeightAtVersion(configVersion, role);
    return BigInt(weight);
  } catch (err) {
    handleContractError(err, this._interface);
  }
}

/**
 * Simulates voting power for a specific proposal using snapshotted weights.
 * This is the accurate pre-flight check for casting votes, as it uses the
 * proposal's pinned configuration version rather than live weights.
 * @param clientAddress The governance client contract address
 * @param proposalId The proposal ID to simulate against
 * @param payload The Proof-of-State payload with roles, scores, and proofs
 * @returns The total voting power at the proposal's snapshot
 */
public async simulateVotingPowerAtSnapshot(
  clientAddress: string,
  proposalId: bigint,
  accountAddress: string, 
  payload: ProofOfStatePayload
): Promise<bigint> {
  this._validatePayload(payload);

  try {
    const readOnlyClient = this._governanceClient(clientAddress);

    const totalPower = await readOnlyClient.getVotingPowerForProposal.staticCall(
      proposalId,
      accountAddress,
      payload.roles,
      payload.scores,
      payload.proofs
    );

    return totalPower;
  } catch (err) {
    handleContractError(err, this._interface);
  }
}

  // Internal ==================================================================

  private _validatePayload(payload: ProofOfStatePayload): void {
    if (payload.roles.length !== payload.scores.length || payload.roles.length !== payload.proofs.length) {
      throw new Error('DRIFT SDK: ProofOfStatePayload arrays must be perfectly parallel.');
    }
  }
}
