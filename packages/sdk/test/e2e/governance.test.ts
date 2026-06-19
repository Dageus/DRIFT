import { describe, test, expect } from 'vitest';
import { Contract } from 'ethers';
import { runGovernanceScenario } from '../scenarios/governance';
import { tester, alice, bob, ADDRESSES } from '../scenarios/_shared';
import IGovArtifact from '../../../contracts/out/IDRIFTGovernanceProofOfState.sol/IDRIFTGovernanceProofOfState.json';

describe('DRIFT Proof-of-State Governance', () => {
  test('full lifecycle: deploy → settle → claim → propose → vote', async () => {
    const result = await runGovernanceScenario(tester, alice, bob);

    expect(result.contextUID).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.clientAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.clientAddress.toLowerCase()).not.toBe(ADDRESSES.WeightedGovernanceTemplate.toLowerCase());
    expect(result.proposalId).toBeGreaterThanOrEqual(0n);
    expect(result.votesFor).toBe(80n);
  });

  test('base castVote is disabled', async () => {
    const result = await runGovernanceScenario(tester, alice, bob);
    const contract = new Contract(result.clientAddress, IGovArtifact.abi, tester);

    try {
      await contract.castVote(result.proposalId, true);
      expect.unreachable('castVote should have reverted');
    } catch (err: any) {
      const errorData = err.data || err.info?.error?.data || err.error?.data;
      const decodedError = contract.interface.parseError(errorData);
      expect(decodedError?.name).toBe('MustUseCastVoteWithProofs');
    }
  });
});
