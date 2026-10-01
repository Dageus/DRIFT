import { parseEther, parseUnits } from 'ethers';

/** Thrown for any invalid experiment configuration; the message lists every problem found. */
export class ExperimentConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid experiment config:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ExperimentConfigError';
  }
}

/** Where the funder's key comes from. Only environment variable names appear in the config. */
export type FunderSource = { privateKeyEnv: string } | { mnemonicEnv: string; index: number };

export interface ExperimentConfig {
  chainId: bigint;
  rpcUrlEnv: string;
  /** Environment variable holding the experiment mnemonic every experiment key derives from. */
  mnemonicEnv: string;
  funder: FunderSource;
  /** Member nodes. */
  nodes: number;
  /** batch > 1 sends each node's attestations of a round in multiAttest transactions of up to `batch`. */
  attestations: { perNodePerRound: number; rounds: number; batch: number };
  tier1: { epochs: number };
  tier2: { epochs: number; owners: number; threshold: number };
  adversarial: {
    /** Tier 1 settler deliberately omits a pair, the node self-challenges, nobody answers, settler re-posts. */
    omissionChallenges: number;
    /** A node challenges an included pair; the settler daemon answers. The node's bond is forfeited. */
    answeredChallenges: number;
    /** Watcher detects an omitting root and challenges it; settler re-posts. */
    watcherChallenges: number;
    /** Tier 2 rounds that die (off-chain only; costs time, not gas). */
    deadRounds: number;
  };
  /** claimReputation calls per settled epoch, spread across nodes. */
  claims: { perEpoch: number };
  governance: { proposals: number; votersPerProposal: number };
  bonds: { settlementWei: bigint; challengeWei: bigint; responseGasEstimate: bigint };
  gas: { maxFeeWei: bigint; priorityFeeWei: bigint };
  /** Safety factor on gas, as basis points (1.5 -> 15000). */
  marginBps: bigint;
  reserveWei: bigint;
  /** Include the one-time contract deployment in the plan (false when reusing a deployment). */
  deploy: boolean;
}

/** Contract floors (WeightedGovernanceClient.MIN_SETTLEMENT_BOND / MIN_CHALLENGE_BOND). */
export const MIN_BOND_WEI = parseEther('0.001');
export const MAX_TIER2_OWNERS = 20;
export const MAX_NODES = 10_000;

type Raw = Record<string, unknown>;

class Checker {
  readonly problems: string[] = [];
  fail(path: string, msg: string): void {
    this.problems.push(`${path}: ${msg}`);
  }
  obj(v: unknown, path: string): Raw | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      this.fail(path, 'expected an object');
      return undefined;
    }
    return v as Raw;
  }
  str(v: unknown, path: string, required = true): string | undefined {
    if (v === undefined) {
      if (required) this.fail(path, 'is required');
      return undefined;
    }
    if (typeof v !== 'string' || v.trim() === '') {
      this.fail(path, 'expected a non-empty string');
      return undefined;
    }
    return v;
  }
  /** Non-negative integer with an optional default and maximum. */
  int(v: unknown, path: string, def?: number, max = Number.MAX_SAFE_INTEGER): number {
    if (v === undefined) {
      if (def === undefined) this.fail(path, 'is required');
      return def ?? 0;
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
      this.fail(path, `expected an integer between 0 and ${max}`);
      return def ?? 0;
    }
    return v;
  }
  /** Decimal amount given as a string (never a float), parsed in the given unit. */
  amount(v: unknown, path: string, unit: 'ether' | 'gwei', def?: string): bigint {
    const s = v === undefined ? def : v;
    if (s === undefined) {
      this.fail(path, 'is required');
      return 0n;
    }
    if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s)) {
      this.fail(path, `expected a decimal string in ${unit}, e.g. "0.001"`);
      return 0n;
    }
    return unit === 'ether' ? parseEther(s) : parseUnits(s, 'gwei');
  }
  envName(v: unknown, path: string): string | undefined {
    const s = this.str(v, path);
    if (s !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(s)) this.fail(path, 'expected an environment variable name (A-Z, 0-9, _)');
    return s;
  }
}

/** Validates a parsed JSON experiment config, reporting every problem at once. */
export function parseExperimentConfig(input: unknown): ExperimentConfig {
  const c = new Checker();
  const root = c.obj(input, 'config') ?? {};
  const known = new Set([
    'chainId', 'rpcUrlEnv', 'mnemonicEnv', 'funder', 'nodes', 'attestations', 'tier1', 'tier2',
    'adversarial', 'claims', 'governance', 'bonds', 'gas', 'margin', 'reserveEth', 'deploy'
  ]);
  for (const k of Object.keys(root)) if (!known.has(k)) c.fail(k, 'unknown field (typo?)');

  const chainId = c.int(root.chainId, 'chainId');
  if (chainId === 0) c.fail('chainId', 'must be the target chain id (11155111 for Sepolia)');
  const rpcUrlEnv = c.envName(root.rpcUrlEnv, 'rpcUrlEnv') ?? '';
  const mnemonicEnv = c.envName(root.mnemonicEnv, 'mnemonicEnv') ?? '';

  let funder: FunderSource = { privateKeyEnv: '' };
  const f = c.obj(root.funder, 'funder');
  if (!f) c.fail('funder', 'is required');
  else if (f.privateKeyEnv !== undefined && f.mnemonicEnv !== undefined) c.fail('funder', 'give privateKeyEnv or mnemonicEnv, not both');
  else if (f.privateKeyEnv !== undefined) funder = { privateKeyEnv: c.envName(f.privateKeyEnv, 'funder.privateKeyEnv') ?? '' };
  else if (f.mnemonicEnv !== undefined) {
    funder = { mnemonicEnv: c.envName(f.mnemonicEnv, 'funder.mnemonicEnv') ?? '', index: c.int(f.index, 'funder.index', 0) };
    if (funder.mnemonicEnv === mnemonicEnv) c.fail('funder.mnemonicEnv', 'must differ from mnemonicEnv: the funder is not an experiment key');
  } else c.fail('funder', 'expected privateKeyEnv or mnemonicEnv');

  const nodes = c.int(root.nodes, 'nodes', undefined, MAX_NODES);
  if (nodes === 0 && root.nodes !== undefined) c.fail('nodes', 'must be at least 1');

  const at = c.obj(root.attestations, 'attestations') ?? {};
  const attestations = { perNodePerRound: c.int(at.perNodePerRound, 'attestations.perNodePerRound', 0), rounds: c.int(at.rounds, 'attestations.rounds', 0), batch: c.int(at.batch, 'attestations.batch', 1, 50) };
  if (attestations.batch === 0) c.fail('attestations.batch', 'must be at least 1');
  if (attestations.perNodePerRound >= nodes && nodes > 0) c.fail('attestations.perNodePerRound', 'must be below nodes (a node attests to distinct other nodes)');

  const t1 = c.obj(root.tier1, 'tier1') ?? {};
  const tier1 = { epochs: c.int(t1.epochs, 'tier1.epochs', 0) };
  const t2 = c.obj(root.tier2, 'tier2') ?? {};
  const tier2 = {
    epochs: c.int(t2.epochs, 'tier2.epochs', 0),
    owners: c.int(t2.owners, 'tier2.owners', 3, MAX_TIER2_OWNERS),
    threshold: c.int(t2.threshold, 'tier2.threshold', 2, MAX_TIER2_OWNERS)
  };
  if (tier2.epochs > 0 && (tier2.threshold < 1 || tier2.threshold > tier2.owners)) c.fail('tier2.threshold', `must be between 1 and owners (${tier2.owners})`);
  if (tier1.epochs + tier2.epochs === 0) c.fail('tier1.epochs', 'at least one tier needs epochs');

  const ad = c.obj(root.adversarial, 'adversarial') ?? {};
  const adversarial = {
    omissionChallenges: c.int(ad.omissionChallenges, 'adversarial.omissionChallenges', 0),
    answeredChallenges: c.int(ad.answeredChallenges, 'adversarial.answeredChallenges', 0),
    watcherChallenges: c.int(ad.watcherChallenges, 'adversarial.watcherChallenges', 0),
    deadRounds: c.int(ad.deadRounds, 'adversarial.deadRounds', 0)
  };
  const tier1Adversarial = adversarial.omissionChallenges + adversarial.answeredChallenges + adversarial.watcherChallenges;
  if (tier1Adversarial > 0 && tier1.epochs === 0) c.fail('adversarial', 'challenge scenarios run on the Tier 1 context, which needs tier1.epochs > 0');
  if (adversarial.deadRounds > 0 && tier2.epochs === 0) c.fail('adversarial.deadRounds', 'needs tier2.epochs > 0');
  if (adversarial.omissionChallenges + adversarial.answeredChallenges > nodes) c.fail('adversarial', 'each node challenger is a distinct node; omission + answered challenges must not exceed nodes');

  const cl = c.obj(root.claims, 'claims') ?? {};
  const claims = { perEpoch: c.int(cl.perEpoch, 'claims.perEpoch', 0, nodes) };
  const gv = c.obj(root.governance, 'governance') ?? {};
  const governance = { proposals: c.int(gv.proposals, 'governance.proposals', 0), votersPerProposal: c.int(gv.votersPerProposal, 'governance.votersPerProposal', 0, nodes) };

  const b = c.obj(root.bonds, 'bonds') ?? {};
  const bonds = {
    settlementWei: c.amount(b.settlementEth, 'bonds.settlementEth', 'ether', '0.001'),
    challengeWei: c.amount(b.challengeEth, 'bonds.challengeEth', 'ether', '0.001'),
    responseGasEstimate: BigInt(c.int(b.responseGasEstimate, 'bonds.responseGasEstimate', 0))
  };
  if (bonds.settlementWei < MIN_BOND_WEI) c.fail('bonds.settlementEth', 'below the contract floor of 0.001 ether');
  if (bonds.challengeWei < MIN_BOND_WEI) c.fail('bonds.challengeEth', 'below the contract floor of 0.001 ether');

  const g = c.obj(root.gas, 'gas') ?? {};
  const gas = { maxFeeWei: c.amount(g.maxFeeGwei, 'gas.maxFeeGwei', 'gwei'), priorityFeeWei: c.amount(g.priorityFeeGwei, 'gas.priorityFeeGwei', 'gwei', '1') };
  if (gas.maxFeeWei === 0n && g.maxFeeGwei !== undefined) c.fail('gas.maxFeeGwei', 'must be positive');
  if (gas.priorityFeeWei > gas.maxFeeWei && gas.maxFeeWei > 0n) c.fail('gas.priorityFeeGwei', 'must not exceed maxFeeGwei');

  let marginBps = 15_000n;
  if (root.margin !== undefined) {
    if (typeof root.margin !== 'number' || !(root.margin >= 1) || root.margin > 10) c.fail('margin', 'expected a number between 1 and 10');
    else marginBps = BigInt(Math.round(root.margin * 10_000));
  }
  const reserveWei = c.amount(root.reserveEth, 'reserveEth', 'ether', '0.02');
  let deploy = true;
  if (root.deploy !== undefined) {
    if (typeof root.deploy !== 'boolean') c.fail('deploy', 'expected a boolean');
    else deploy = root.deploy;
  }

  if (c.problems.length) throw new ExperimentConfigError(c.problems);
  return {
    chainId: BigInt(chainId), rpcUrlEnv, mnemonicEnv, funder, nodes, attestations, tier1, tier2, adversarial,
    claims, governance, bonds, gas, marginBps, reserveWei, deploy
  };
}
