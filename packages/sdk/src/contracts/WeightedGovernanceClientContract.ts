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
 * Hand-typed surface shared by GovernanceModule and ReputationModule — both operate on the same
 * deployed contract, so both build their `Contract` against this one ABI. Deliberately the
 * concrete `WeightedGovernanceClient.json`, not the narrower `IDRIFTGovernanceProofOfState.json`/
 * `IDRIFTSettler.json` interface ABIs: `getActiveRoles` and ~30 of the client's own custom errors
 * aren't declared on any interface, so the narrow ABI silently broke both `getActiveRoles()` and
 * most revert decoding. Keep in sync with WeightedGovernance.sol by hand (see TODO.md section 2).
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

  // B1 — non-inclusion disputes ===============================================
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

  // Governance proposals/voting ===============================================
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

  // Client-specific ===========================================================
  getActiveRoles(): Promise<string[]>;

  // Role membership ===========================================================
  assignRole(node: string, role: string): Promise<ContractTransactionResponse>;
  revokeRole(node: string, role: string): Promise<ContractTransactionResponse>;
  hasNodeRole(node: string, role: string): Promise<boolean>;
  getNodeRoles(node: string): Promise<string[]>;
}
