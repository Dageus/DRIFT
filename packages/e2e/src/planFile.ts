import { readFileSync, writeFileSync } from 'node:fs';
import type { FundingPlan, KeyPlan } from './plan.js';
import type { KeySlot } from './keys.js';

const big = (v: unknown) => BigInt(v as string);
const toJson = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n';

export function writePlan(path: string, plan: FundingPlan): void {
  writeFileSync(path, toJson({ version: 1, ...plan }));
}

export function readPlan(path: string): FundingPlan {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { keys: Record<string, unknown>[] };
  if (raw.version !== 1) throw new Error(`${path}: unsupported plan version ${String(raw.version)}`);
  return {
    chainId: big(raw.chainId),
    maxFeeWei: big(raw.maxFeeWei),
    marginBps: big(raw.marginBps),
    funderFeeWei: big(raw.funderFeeWei),
    totalTargetWei: big(raw.totalTargetWei),
    reserveWei: big(raw.reserveWei),
    requiredWei: big(raw.requiredWei),
    estimatedActions: raw.estimatedActions as FundingPlan['estimatedActions'],
    keys: raw.keys.map(
      (k): KeyPlan => ({
        role: k.role as KeyPlan['role'],
        ordinal: k.ordinal as number,
        index: k.index as number,
        path: k.path as string,
        address: k.address as string,
        actions: (k.actions as Record<string, unknown>[]).map((a) => ({
          action: a.action as KeyPlan['actions'][number]['action'],
          count: a.count as number,
          gasEach: big(a.gasEach),
          source: a.source as 'estimate' | 'measured'
        })),
        gasUnits: big(k.gasUnits),
        gasWei: big(k.gasWei),
        capitalWei: big(k.capitalWei),
        capitalNote: k.capitalNote as string,
        targetWei: big(k.targetWei)
      })
    )
  };
}

/**
 * Refuses a plan whose addresses do not match the ones derived now: funding must never go to
 * addresses from a different mnemonic or an edited plan file.
 */
export function assertPlanMatches(plan: FundingPlan, derived: KeySlot[]): void {
  const byIndex = new Map(derived.map((d) => [d.index, d.address.toLowerCase()]));
  for (const k of plan.keys) {
    const d = byIndex.get(k.index);
    if (d === undefined) throw new Error(`plan key ${k.role} ${k.ordinal} (index ${k.index}) is not in the current experiment; re-run plan`);
    if (d !== k.address.toLowerCase()) throw new Error(`plan key ${k.role} ${k.ordinal} is ${k.address}, but the experiment mnemonic derives ${d} at index ${k.index}; refusing`);
  }
  if (derived.length !== plan.keys.length) throw new Error(`the experiment now has ${derived.length} keys, the plan ${plan.keys.length}; re-run plan`);
}

export function writeManifest(path: string, slots: KeySlot[]): void {
  writeFileSync(path, toJson({ version: 1, keys: slots.map(({ role, ordinal, index, path: p, address }) => ({ role, ordinal, index, path: p, address })) }));
}
