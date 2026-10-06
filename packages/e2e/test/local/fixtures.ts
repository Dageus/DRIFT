export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

/** A small, valid experiment config; tests override fields. */
export function baseConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 31337,
    rpcUrlEnv: 'E2E_RPC_URL',
    mnemonicEnv: 'E2E_MNEMONIC',
    funder: { privateKeyEnv: 'FUNDER_PRIVATE_KEY' },
    nodes: 6,
    attestations: { perNodePerRound: 2, rounds: 3 },
    tier1: { epochs: 4 },
    tier2: { epochs: 3, owners: 3, threshold: 2 },
    adversarial: { omissionChallenges: 1, answeredChallenges: 1, watcherChallenges: 1, deadRounds: 1 },
    claims: { perEpoch: 2 },
    governance: { proposals: 2, votersPerProposal: 3 },
    bonds: { settlementEth: '0.001', challengeEth: '0.001' },
    gas: { maxFeeGwei: '10', priorityFeeGwei: '1' },
    margin: 1.5,
    reserveEth: '0.01',
    ...over
  };
}
