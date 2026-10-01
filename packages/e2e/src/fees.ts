import { formatUnits, parseUnits, type JsonRpcProvider, type Provider } from 'ethers';
import type { Log } from './ops.js';

export interface FeeHistory {
  fromBlock: number;
  toBlock: number;
  /** Base fee per block, in wei. */
  baseFees: bigint[];
  /** Median priority fee paid per block, in wei. */
  medianTips: bigint[];
}

/**
 * Read-only eth_feeHistory over the last `blocks` blocks, in calls of at most 1024 blocks. Stops early
 * where the RPC stops serving history; the report states the range actually covered.
 */
export async function feeHistory(provider: JsonRpcProvider, blocks: number): Promise<FeeHistory> {
  const head = await provider.getBlockNumber();
  const baseFees: bigint[] = [];
  const medianTips: bigint[] = [];
  let newest = head;
  let remaining = blocks;
  while (remaining > 0) {
    const n = Math.min(1024, remaining);
    let r: { oldestBlock: string; baseFeePerGas: string[]; reward?: string[][] };
    try {
      r = (await provider.send('eth_feeHistory', ['0x' + n.toString(16), '0x' + newest.toString(16), [50]])) as typeof r;
    } catch (err) {
      // Public RPCs keep only a window of fee history; stop at its edge rather than fail.
      if (baseFees.length > 0) break;
      throw err;
    }
    // baseFeePerGas has n + 1 entries (the last is the next block's); keep the n mined blocks.
    const bf = r.baseFeePerGas.slice(0, n).map((x) => BigInt(x));
    const tips = (r.reward ?? []).map((x) => BigInt(x[0] ?? '0x0'));
    baseFees.unshift(...bf);
    medianTips.unshift(...tips);
    newest = Number(BigInt(r.oldestBlock)) - 1;
    remaining -= n;
    if (newest < 0) break;
  }
  return { fromBlock: head - baseFees.length + 1, toBlock: head, baseFees, medianTips };
}

/** Nearest-rank percentile. */
export function percentile(values: bigint[], p: number): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

export interface FeeReport {
  blocks: number;
  fromBlock: number;
  toBlock: number;
  base: Record<string, bigint>;
  tip: Record<string, bigint>;
  /** Fraction of blocks whose base fee + `priorityWei` exceeds each candidate cap (gwei string). */
  exceeded: { capGwei: string; share: number }[];
}

export const PERCENTILES = [50, 75, 90, 95, 99, 100] as const;

export function feeReport(h: FeeHistory, priorityWei: bigint, capsGwei: string[]): FeeReport {
  const base: Record<string, bigint> = {};
  const tip: Record<string, bigint> = {};
  for (const p of PERCENTILES) {
    base[`p${p}`] = percentile(h.baseFees, p);
    tip[`p${p}`] = percentile(h.medianTips, p);
  }
  const exceeded = capsGwei.map((c) => {
    const cap = parseUnits(c, 'gwei');
    return { capGwei: c, share: h.baseFees.filter((b) => b + priorityWei > cap).length / Math.max(1, h.baseFees.length) };
  });
  return { blocks: h.baseFees.length, fromBlock: h.fromBlock, toBlock: h.toBlock, base, tip, exceeded };
}

export function printFeeReport(r: FeeReport, log: Log, priorityWei: bigint): void {
  const g = (w: bigint) => Number(formatUnits(w, 'gwei')).toFixed(3);
  log(`base fee over ${r.blocks} blocks (${r.fromBlock}..${r.toBlock}), gwei:`);
  log('  ' + PERCENTILES.map((p) => `p${p === 100 ? 'max' : p} ${g(r.base[`p${p}`]!)}`).join('  '));
  log('median priority fee per block, gwei:');
  log('  ' + PERCENTILES.map((p) => `p${p === 100 ? 'max' : p} ${g(r.tip[`p${p}`]!)}`).join('  '));
  log(`share of blocks where base fee + priority (${formatUnits(priorityWei, 'gwei')} gwei) exceeds the cap:`);
  for (const { capGwei, share } of r.exceeded) log(`  cap ${capGwei.padStart(5)} gwei: ${(share * 100).toFixed(2)}%`);
}

/**
 * Waits until base fee + priority fits under the cap, polling every `pollMs`, for at most `waitMs`.
 * Paying more than the cap is never an option: past the deadline it throws.
 */
export async function waitForFeesUnderCap(
  provider: Provider,
  maxFeeWei: bigint,
  priorityWei: bigint,
  opts: { waitMs: number; pollMs?: number; log?: Log } = { waitMs: 0 }
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; baseFee: bigint }> {
  const deadline = Date.now() + opts.waitMs;
  let announced = false;
  for (;;) {
    const block = await provider.getBlock('latest');
    const baseFee = block?.baseFeePerGas ?? 0n;
    if (baseFee + priorityWei <= maxFeeWei) return { maxFeePerGas: maxFeeWei, maxPriorityFeePerGas: priorityWei, baseFee };
    if (Date.now() >= deadline) {
      throw new Error(
        `base fee ${formatUnits(baseFee, 'gwei')} gwei + priority ${formatUnits(priorityWei, 'gwei')} gwei is above the cap of ${formatUnits(maxFeeWei, 'gwei')} gwei; waited ${Math.round(opts.waitMs / 60_000)} min. Retry later (nothing above the cap is ever sent).`
      );
    }
    if (!announced) {
      opts.log?.(`base fee ${formatUnits(baseFee, 'gwei')} gwei is above the cap; waiting (up to ${Math.round(opts.waitMs / 60_000)} min) instead of overpaying`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 12_000));
  }
}
