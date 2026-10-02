import type { ExperimentConfig } from './config.js';
import type { Action, GasTable } from './gas.js';
import type { KeySlot } from './keys.js';

export interface PlannedAction {
  action: Action;
  count: number;
  gasEach: bigint;
  source: 'estimate' | 'measured';
}

export interface KeyPlan extends KeySlot {
  actions: PlannedAction[];
  gasUnits: bigint;
  /** gasUnits x maxFee x margin. */
  gasWei: bigint;
  /** ETH the key must hold besides gas: bonds, the Safe's bond capital. Not multiplied by the margin. */
  capitalWei: bigint;
  capitalNote: string;
  targetWei: bigint;
}

export interface FundingPlan {
  chainId: bigint;
  maxFeeWei: bigint;
  marginBps: bigint;
  keys: KeyPlan[];
  /** The funder's own transfer fees (one transfer per funded key), with margin. */
  funderFeeWei: bigint;
  totalTargetWei: bigint;
  reserveWei: bigint;
  /** totalTargetWei + funderFeeWei + reserveWei, for a funder starting from zero-balance keys. */
  requiredWei: bigint;
  /** Actions in the plan whose gas is still an estimate. */
  estimatedActions: Action[];
}

/** Splits `total` items over `n` slots round-robin; slot i gets floor(total/n) + (i < total mod n). */
export function share(total: number, n: number, i: number): number {
  if (n === 0) return 0;
  return Math.floor(total / n) + (i < total % n ? 1 : 0);
}

const BPS = 10_000n;
const CHALLENGE_BOND_MARGIN_BPS = 12_000n;

/** The contract's requiredChallengeBond at the worst base fee the plan allows (maxFee). */
export function challengeBondWei(cfg: ExperimentConfig): bigint {
  const responseCost = (cfg.bonds.responseGasEstimate * cfg.gas.maxFeeWei * CHALLENGE_BOND_MARGIN_BPS) / BPS;
  return responseCost > cfg.bonds.challengeWei ? responseCost : cfg.bonds.challengeWei;
}

/** Per-key actions for the experiment, with bond capital. Pure: no chain access. */
export function keyActions(cfg: ExperimentConfig, slot: KeySlot): { actions: [Action, number][]; capitalWei: bigint; capitalNote: string } {
  const contexts = (cfg.tier1.epochs > 0 ? 1 : 0) + (cfg.tier2.epochs > 0 ? 1 : 0);
  const watcher = cfg.adversarial.watcherChallenges > 0 ? 1 : 0;
  const { omissionChallenges: om, answeredChallenges: ans, watcherChallenges: wc } = cfg.adversarial;
  const sb = cfg.bonds.settlementWei;
  const cb = challengeBondWei(cfg);
  const a: [Action, number][] = [];
  let capitalWei = 0n;
  let capitalNote = '';

  switch (slot.role) {
    case 'deployer': {
      if (cfg.deploy) {
        for (const x of ['deployCoreImpl', 'deployCoreProxy', 'deployToken', 'setDriftToken', 'deployFactory', 'grantFactoryRole', 'deployTemplate'] as const) a.push([x, 1]);
      }
      a.push(['registerSchema', 1]);
      for (const x of ['registerContext', 'deployClientClone', 'grantContextAdmin', 'setDisputeWindow', 'setResponseWindow', 'setSettlementBond', 'setChallengeBond', 'setEpochLength'] as const) a.push([x, contexts]);
      if (cfg.bonds.responseGasEstimate > 0n) a.push(['setResponseGasEstimate', contexts]);
      // Every node gets the member role in every context; the watcher's key also in the Tier 1 context.
      a.push(['assignRole', cfg.nodes * contexts + watcher]);
      if (cfg.tier2.epochs > 0) {
        a.push(['createSafe', 1], ['fundSafe', 1]);
        // Two settlement bonds in flight: epoch E+1 can be posted before E's bond is withdrawn.
        capitalWei = 2n * sb;
        capitalNote = 'Safe bond capital, 2 x settlement bond (transferred to the Safe)';
      }
      break;
    }
    case 'tier1-settler': {
      // Every successful omission challenge rolls the epoch back: one more posting and one forfeited bond.
      a.push(['postEpochRoot', cfg.tier1.epochs + om + wc]);
      capitalWei = (2n + BigInt(om + wc)) * sb;
      capitalNote = `2 bonds in flight + ${om + wc} forfeited`;
      break;
    }
    case 'tier1-hot':
      a.push(['respondToChallenge', ans], ['withdrawSettlementBond', cfg.tier1.epochs]);
      break;
    case 'tier2-hot': {
      // One per owner. The executor rotates between the signers of each round, and a backup
      // executes only if the elected one did not, so each owner's share is about epochs/owners;
      // 1.5x that covers an uneven rotation, and an owner that runs dry is covered by a backup.
      const shareOf = Math.min(cfg.tier2.epochs, Math.ceil((1.5 * cfg.tier2.epochs) / Math.max(1, cfg.tier2.owners)));
      a.push(['safeExecSettlement', shareOf], ['withdrawSettlementBond', shareOf]);
      break;
    }
    case 'watcher-hot':
      a.push(['registerNode', 1], ['challengeOmission', wc], ['claimUnansweredChallenge', wc]);
      capitalWei = BigInt(wc) * cb;
      capitalNote = `${wc} challenge bond(s), returned with the forfeited settlement bond on claim`;
      break;
    case 'tier2-owner':
      // Off-chain signatures only.
      break;
    case 'node': {
      const i = slot.ordinal;
      const n = cfg.nodes;
      const epochs = cfg.tier1.epochs + cfg.tier2.epochs;
      a.push(['registerNode', contexts]);
      if (cfg.attestations.batch > 1) a.push(['easMultiAttest', Math.ceil(cfg.attestations.perNodePerRound / cfg.attestations.batch) * cfg.attestations.rounds]);
      else a.push(['easAttest', cfg.attestations.perNodePerRound * cfg.attestations.rounds]);
      a.push(['claimReputation', share(cfg.claims.perEpoch * epochs, n, i)]);
      a.push(['createProposal', share(cfg.governance.proposals, n, i)]);
      a.push(['castVote', share(cfg.governance.proposals * cfg.governance.votersPerProposal, n, i)]);
      // Node challengers are the first om (omission, self-challenge, claimed) and next ans (answered) nodes.
      if (i < om) {
        a.push(['challengeOmission', 1], ['claimUnansweredChallenge', 1]);
        capitalWei = cb;
        capitalNote = 'challenge bond, returned on claim';
      } else if (i < om + ans) {
        a.push(['challengeOmission', 1]);
        capitalWei = cb;
        capitalNote = 'challenge bond, forfeited to the settler';
      }
      break;
    }
  }
  return { actions: a.filter(([, c]) => c > 0), capitalWei, capitalNote };
}

/**
 * The gas of one transaction of `action`. A multiAttest batch is priced at its largest size,
 * base + perItem x min(batch, attestations per round), so a smaller last batch only overestimates.
 */
function batchedEntry(cfg: ExperimentConfig, table: GasTable, action: Action): { gas: bigint; source: 'estimate' | 'measured' } {
  if (action !== 'easMultiAttest') return table[action];
  const k = BigInt(Math.min(cfg.attestations.batch, cfg.attestations.perNodePerRound));
  const base = table.easMultiAttestBase;
  const per = table.easMultiAttestPerItem;
  return { gas: base.gas + per.gas * k, source: base.source === 'measured' && per.source === 'measured' ? 'measured' : 'estimate' };
}

/** Builds the funding plan: every key's target balance, the funder's fees, and the total needed. */
export function buildPlan(cfg: ExperimentConfig, slots: KeySlot[], table: GasTable): FundingPlan {
  const estimated = new Set<Action>();
  const keys: KeyPlan[] = slots.map((slot) => {
    const { actions, capitalWei, capitalNote } = keyActions(cfg, slot);
    const planned: PlannedAction[] = actions.map(([action, count]) => {
      const e = batchedEntry(cfg, table, action);
      if (e.source === 'estimate') estimated.add(action);
      return { action, count, gasEach: e.gas, source: e.source };
    });
    // Leave room for one sweep transfer back to the funder.
    if (planned.length > 0 || capitalWei > 0n) planned.push({ action: 'transfer', count: 1, gasEach: table.transfer.gas, source: table.transfer.source });
    const gasUnits = planned.reduce((s, p) => s + p.gasEach * BigInt(p.count), 0n);
    const gasWei = (gasUnits * cfg.gas.maxFeeWei * cfg.marginBps) / BPS;
    return { ...slot, actions: planned, gasUnits, gasWei, capitalWei, capitalNote, targetWei: gasWei + capitalWei };
  });
  const funded = keys.filter((k) => k.targetWei > 0n).length;
  const funderFeeWei = (BigInt(funded) * table.transfer.gas * cfg.gas.maxFeeWei * cfg.marginBps) / BPS;
  const totalTargetWei = keys.reduce((s, k) => s + k.targetWei, 0n);
  return {
    chainId: cfg.chainId,
    maxFeeWei: cfg.gas.maxFeeWei,
    marginBps: cfg.marginBps,
    keys,
    funderFeeWei,
    totalTargetWei,
    reserveWei: cfg.reserveWei,
    requiredWei: totalTargetWei + funderFeeWei + cfg.reserveWei,
    estimatedActions: [...estimated].sort()
  };
}

/** Top-ups that bring each key to its target. Keys at or above target get nothing, so re-running is a no-op. */
export function topUps(plan: FundingPlan, balances: Map<string, bigint>): { address: string; role: string; ordinal: number; amount: bigint }[] {
  const out: { address: string; role: string; ordinal: number; amount: bigint }[] = [];
  for (const k of plan.keys) {
    if (k.targetWei === 0n) continue;
    const have = balances.get(k.address.toLowerCase());
    if (have === undefined) throw new Error(`no balance read for ${k.address}`);
    if (have < k.targetWei) out.push({ address: k.address, role: k.role, ordinal: k.ordinal, amount: k.targetWei - have });
  }
  return out;
}
