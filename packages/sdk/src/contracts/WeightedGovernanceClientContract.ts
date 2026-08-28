import type { BaseContract, ContractTransactionResponse, Overrides } from 'ethers';

export interface ProposalView {
  description: string;
  target: string;
  payload: string;
  votesFor: bigint;
  votesAgainst: bigint;
  deadline: bigint;
  executed: boolean;
  exists: boolean;
}

export interface ProposalSnapshotView {
  snapshotEpoch: bigint;
  configVersion: bigint;
}

/**
 * Hand-typed surface of the WeightedGovernanceClient ABI used by both GovernanceModule and
 * ReputationModule — they're two logical groupings of methods over the *same* deployed contract,
 * not two different contracts, so both modules construct their `Contract` instance against this
 * one concrete ABI. Deliberately NOT built from `IDRIFTGovernanceProofOfState.json` or
 * `IDRIFTSettler.json` (the interface ABIs): `getActiveRoles` isn't declared on any interface
 * this client implements, and roughly 30 of the client's own custom errors (`InvalidEpoch`,
 * `WeightsNotNormalized`, `BondBelowFloor`, ...) live directly on the concrete contract rather
 * than an interface — using the narrow interface ABI silently broke both `getActiveRoles()` calls
 * and revert-reason decoding for most real revert cases. Not generated (no typechain step yet —
 * see packages/sdk/TODO.md section 2), so keep this in sync with
 * `packages/contracts/src/templates/WeightedGovernance.sol` by hand.
 */
export interface WeightedGovernanceClientContract extends BaseContract {
  // Settlement (IDRIFTSettler) ================================================
  setTrustedSettler(newSettler: string): Promise<ContractTransactionResponse>;
  postEpochRoot(
    epoch: bigint,
    merkleRoot: string,
    treeURI: string,
    signature: string,
    overrides?: Overrides
  ): Promise<ContractTransactionResponse>;
  claimReputation(
    node: string,
    role: string,
    score: bigint,
    epoch: bigint,
    merkleProof: string[]
  ): Promise<ContractTransactionResponse>;
  verifyReputation(node: string, role: string, score: bigint, epoch: bigint, merkleProof: string[]): Promise<boolean>;

  // B1 — non-inclusion disputes
  challengeOmission(
    epoch: bigint,
    missingNode: string,
    overrides?: Overrides
  ): Promise<ContractTransactionResponse>;
  respondToChallenge(
    epoch: bigint,
    node: string,
    role: string,
    score: bigint,
    merkleProof: string[]
  ): Promise<ContractTransactionResponse>;
  claimUnansweredChallenge(epoch: bigint, node: string): Promise<ContractTransactionResponse>;
  reclaimMootChallenge(epoch: bigint, node: string): Promise<ContractTransactionResponse>;
  withdrawSettlementBond(epoch: bigint): Promise<ContractTransactionResponse>;

  // Governance proposals/voting (IDRIFTGovernance / IDRIFTGovernanceProofOfState) =============
  createProposalWithProofs(
    description: string,
    target: string,
    payload: string,
    durationInDays: number,
    roles: string[],
    scores: bigint[],
    proofs: string[][]
  ): Promise<ContractTransactionResponse>;
  castVoteWithProofs(
    proposalId: bigint,
    support: boolean,
    roles: string[],
    scores: bigint[],
    proofs: string[][]
  ): Promise<ContractTransactionResponse>;
  executeProposal(proposalId: bigint): Promise<ContractTransactionResponse>;
  hasVoted(proposalId: bigint, account: string): Promise<boolean>;
  getProposal(proposalId: bigint): Promise<ProposalView>;
  getProposalSnapshot(proposalId: bigint): Promise<ProposalSnapshotView>;
  getWeightAtVersion(version: number, role: string): Promise<bigint>;
  getVotingPowerAtEpoch(
    account: string,
    epoch: bigint,
    roles: string[],
    scores: bigint[],
    proofs: string[][]
  ): Promise<bigint>;
  getVotingPowerForProposal: {
    (
      proposalId: bigint,
      account: string,
      roles: string[],
      scores: bigint[],
      proofs: string[][]
    ): Promise<ContractTransactionResponse>;
    staticCall(
      proposalId: bigint,
      account: string,
      roles: string[],
      scores: bigint[],
      proofs: string[][]
    ): Promise<bigint>;
  };

  // Client-specific (not on any interface) =====================================
  getActiveRoles(): Promise<string[]>;
}
