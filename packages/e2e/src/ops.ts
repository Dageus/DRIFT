import { appendFileSync } from 'node:fs';
import type { Provider, Signer, TransactionResponse } from 'ethers';
import { formatEther, formatUnits } from 'ethers';
import type { FundingPlan } from './plan.js';
import { topUps } from './plan.js';
import { waitForFeesUnderCap } from './fees.js';

export const TRANSFER_GAS = 21_000n;
/** Transfers sent before waiting for their receipts; public RPCs cap pending transactions per sender. */
const BATCH = 16;

export type Log = (line: string) => void;

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

function journal(path: string | undefined, entry: Record<string, unknown>): void {
  if (path) appendFileSync(path, json({ at: new Date().toISOString(), ...entry }) + '\n');
}

export async function balancesOf(provider: Provider, addresses: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (let i = 0; i < addresses.length; i += 20) {
    const chunk = addresses.slice(i, i + 20);
    const bals = await Promise.all(chunk.map((a) => provider.getBalance(a)));
    chunk.forEach((a, j) => out.set(a.toLowerCase(), bals[j]!));
  }
  return out;
}

export async function assertChain(provider: Provider, chainId: bigint): Promise<void> {
  const actual = (await provider.getNetwork()).chainId;
  if (actual !== chainId) throw new Error(`connected to chain ${actual}, but the plan is for chain ${chainId}; refusing`);
}

/** Refuses when `address` has transactions still pending: a re-run must see their effect first. */
export async function assertNoPending(provider: Provider, address: string): Promise<number> {
  const [latest, pending] = await Promise.all([provider.getTransactionCount(address, 'latest'), provider.getTransactionCount(address, 'pending')]);
  if (pending !== latest) throw new Error(`${address} has ${pending - latest} pending transaction(s); wait for them before running again`);
  return latest;
}

export { waitForFeesUnderCap } from './fees.js';

export interface FundResult {
  dryRun: boolean;
  transfers: { address: string; role: string; ordinal: number; amount: bigint; hash?: string }[];
  totalWei: bigint;
  feesWei: bigint;
  funderBalanceWei: bigint;
}

/**
 * Tops up every key in the plan to its target. Dry run unless `yes`. Refuses on a chain-id mismatch,
 * pending funder transactions, or a funder balance below top-ups + fees + reserve; while the base fee
 * is above the cap it waits up to `waitMs`, and never sends above the cap. Sends in batches with explicit nonces, waits for every receipt, stops at the first failure,
 * and journals each transfer.
 */
export async function fund(
  plan: FundingPlan,
  funder: Signer,
  opts: { yes: boolean; priorityWei: bigint; journalPath?: string; log: Log; waitMs?: number; pollMs?: number }
): Promise<FundResult> {
  const provider = funder.provider;
  if (!provider) throw new Error('funder signer has no provider');
  await assertChain(provider, plan.chainId);
  const from = await funder.getAddress();
  let nonce = await assertNoPending(provider, from);
  const fees = await waitForFeesUnderCap(provider, plan.maxFeeWei, opts.priorityWei, { waitMs: opts.waitMs ?? 0, pollMs: opts.pollMs, log: opts.log });

  const balances = await balancesOf(provider, plan.keys.map((k) => k.address));
  const todo: FundResult['transfers'] = topUps(plan, balances);
  const totalWei = todo.reduce((s, t) => s + t.amount, 0n);
  const feesWei = BigInt(todo.length) * TRANSFER_GAS * plan.maxFeeWei;
  const funderBalanceWei = await provider.getBalance(from);
  const result: FundResult = { dryRun: !opts.yes, transfers: todo, totalWei, feesWei, funderBalanceWei };

  opts.log(`funder ${from}: ${formatEther(funderBalanceWei)} ETH`);
  opts.log(`${todo.length} top-up(s), ${formatEther(totalWei)} ETH + at most ${formatEther(feesWei)} ETH in fees (base fee now ${formatUnits(fees.baseFee, 'gwei')} gwei)`);
  if (todo.length === 0) {
    opts.log('every key is at or above its target; nothing to send');
    return result;
  }
  const after = funderBalanceWei - totalWei - feesWei;
  opts.log(`funder balance after: at least ${formatEther(after)} ETH (reserve ${formatEther(plan.reserveWei)} ETH)`);
  if (after < plan.reserveWei) {
    throw new Error(`funder would end below the reserve (${formatEther(after)} < ${formatEther(plan.reserveWei)} ETH); refusing`);
  }
  if (!opts.yes) {
    opts.log('dry run: pass --yes to send');
    return result;
  }

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const sent: { t: (typeof todo)[number]; tx: TransactionResponse }[] = [];
    let sendError: unknown;
    for (const t of batch) {
      try {
        const tx = await funder.sendTransaction({
          to: t.address, value: t.amount, nonce, gasLimit: TRANSFER_GAS, type: 2,
          maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, chainId: plan.chainId
        });
        nonce++;
        sent.push({ t, tx });
        journal(opts.journalPath, { kind: 'fund', status: 'sent', to: t.address, role: t.role, ordinal: t.ordinal, value: t.amount, hash: tx.hash, nonce: tx.nonce });
      } catch (err) {
        sendError = err;
        break;
      }
    }
    // Wait for everything already sent, even after a send error, so the journal and chain agree.
    for (const { t, tx } of sent) {
      const r = await tx.wait();
      const ok = r?.status === 1;
      journal(opts.journalPath, { kind: 'fund', status: ok ? 'mined' : 'failed', to: t.address, hash: tx.hash, block: r?.blockNumber, gasUsed: r?.gasUsed, effectiveGasPrice: r?.gasPrice });
      t.hash = tx.hash;
      if (!ok) throw new Error(`transfer to ${t.address} (${t.role} ${t.ordinal}) failed in ${tx.hash}; stopping`);
      opts.log(`  ${t.role} ${t.ordinal} ${t.address} +${formatEther(t.amount)} ETH  ${tx.hash}`);
    }
    if (sendError) throw new Error(`sending to ${batch[sent.length]?.address} failed: ${(sendError as Error).message}; earlier transfers were mined and journaled, re-run to continue`);
  }
  return result;
}

export interface StatusRow {
  role: string;
  ordinal: number;
  address: string;
  targetWei: bigint;
  balanceWei: bigint;
  ok: boolean;
}

export async function status(plan: FundingPlan, provider: Provider): Promise<StatusRow[]> {
  await assertChain(provider, plan.chainId);
  const balances = await balancesOf(provider, plan.keys.map((k) => k.address));
  return plan.keys.map((k) => {
    const balanceWei = balances.get(k.address.toLowerCase())!;
    return { role: k.role, ordinal: k.ordinal, address: k.address, targetWei: k.targetWei, balanceWei, ok: balanceWei >= k.targetWei };
  });
}

/** What a sweep sends: the balance minus the worst-case transfer fee, or nothing if that leaves no more than `dustWei`. */
export function sweepAmount(balanceWei: bigint, maxFeePerGas: bigint, dustWei: bigint): bigint {
  const fee = TRANSFER_GAS * maxFeePerGas;
  const value = balanceWei - fee;
  return value > dustWei ? value : 0n;
}

export interface SweepResult {
  dryRun: boolean;
  transfers: { address: string; role: string; ordinal: number; amount: bigint; hash?: string }[];
  totalWei: bigint;
}

/**
 * Returns each key's balance, minus its transfer fee, to `to`. The fee is fixed at the cap the
 * caller passes, so a key ends with at most 21000 x (cap - effective gas price) of dust.
 */
export async function sweep(
  keys: { role: string; ordinal: number; signer: Signer }[],
  to: string,
  chainId: bigint,
  opts: { yes: boolean; maxFeeWei: bigint; priorityWei: bigint; dustWei: bigint; journalPath?: string; log: Log; waitMs?: number; pollMs?: number }
): Promise<SweepResult> {
  const provider = keys[0]?.signer.provider;
  if (!provider) return { dryRun: !opts.yes, transfers: [], totalWei: 0n };
  await assertChain(provider, chainId);
  const fees = await waitForFeesUnderCap(provider, opts.maxFeeWei, opts.priorityWei, { waitMs: opts.waitMs ?? 0, pollMs: opts.pollMs, log: opts.log });
  const result: SweepResult = { dryRun: !opts.yes, transfers: [], totalWei: 0n };
  for (const k of keys) {
    const address = await k.signer.getAddress();
    const balance = await provider.getBalance(address);
    const amount = sweepAmount(balance, fees.maxFeePerGas, opts.dustWei);
    if (amount === 0n) continue;
    const entry: SweepResult['transfers'][number] = { address, role: k.role, ordinal: k.ordinal, amount };
    result.transfers.push(entry);
    result.totalWei += amount;
    if (!opts.yes) continue;
    const nonce = await assertNoPending(provider, address);
    const tx = await k.signer.sendTransaction({
      to, value: amount, nonce, gasLimit: TRANSFER_GAS, type: 2,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, chainId
    });
    journal(opts.journalPath, { kind: 'sweep', status: 'sent', from: address, role: k.role, ordinal: k.ordinal, value: amount, hash: tx.hash });
    const r = await tx.wait();
    const ok = r?.status === 1;
    journal(opts.journalPath, { kind: 'sweep', status: ok ? 'mined' : 'failed', from: address, hash: tx.hash, block: r?.blockNumber });
    if (!ok) throw new Error(`sweep from ${address} failed in ${tx.hash}; stopping`);
    entry.hash = tx.hash;
    opts.log(`  ${k.role} ${k.ordinal} ${address} -${formatEther(amount)} ETH  ${tx.hash}`);
  }
  opts.log(`${result.transfers.length} sweep(s), ${formatEther(result.totalWei)} ETH back to ${to}${opts.yes ? '' : ' (dry run: pass --yes to send)'}`);
  return result;
}
