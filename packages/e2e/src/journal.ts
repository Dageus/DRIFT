import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { keccak256, type HDNodeWallet, type JsonRpcProvider, type TransactionReceipt } from 'ethers';
import type { ScopedRecorder } from '@drift-network/operator';
import { waitForFeesUnderCap, type Log } from './ops.js';

export interface StepRecord {
  status: 'pending' | 'done';
  at: string;
  /** Transaction steps: the signed transaction is saved before it is broadcast. */
  tx?: string;
  from?: string;
  nonce?: number;
  raw?: string;
  /** Set when the step was found already done on chain, with no transaction of ours. */
  reconciled?: boolean;
  gasUsed?: string;
  block?: number;
  /** Free-form result of the step (e.g. a created proposal id), kept for resume. */
  result?: string;
}

/** Saves a JSON file atomically and durably: temp file, fsync, rename. */
export function saveJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(value, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Thrown by the fault-injection hooks the tests use to simulate a crash. */
export class SimulatedCrash extends Error {}

export interface JournalOptions {
  provider: JsonRpcProvider;
  chainId: bigint;
  /** The step records, owned by the caller's state file. */
  steps: Record<string, StepRecord>;
  /** Persists the caller's state file (durably). Called after every change to `steps`. */
  save: () => void;
  maxFeeWei: bigint;
  priorityFeeWei: bigint;
  log: Log;
  /** How long a send waits for the base fee to fall under the cap. */
  waitMs?: number;
  /** How long to wait for a receipt before giving up (the step stays pending, resumable). */
  receiptTimeoutMs?: number;
  /** Test-only fault injection: crash after the n-th broadcast, or after saving but before broadcasting it. */
  faults?: { crashAfterBroadcast?: number; crashBeforeBroadcast?: number };
  /** Gas-limit headroom over the estimate, basis points. Default 13000 (x1.3). */
  gasLimitBps?: bigint;
  /** How often to poll for a receipt. Default 2000 ms. */
  receiptPollMs?: number;
  /** How long to keep re-reading chain state after a receipt before concluding the step is not done. Default 30000 ms. */
  readLagMs?: number;
}

export interface StepOptions {
  /** Recorder scope for tx.sent / tx.mined, with the action label. Omitted: not recorded. */
  record?: { recorder: ScopedRecorder; action: string };
  /** Log a line per mined transaction. Default true. */
  verbose?: boolean;
}

/**
 * Sends transactions so that a crash at any point never produces a duplicate. A step first asks
 * the chain whether it is already done. Each transaction is signed and saved before it is
 * broadcast; on resume a saved transaction is waited for if the network knows it, re-broadcast
 * byte for byte if it does not, or reconciled from chain state if its nonce went to something
 * else. Steps of different signers may run concurrently; one signer's steps must run one at a time.
 * Fees never exceed the cap: above it, a send waits.
 */
export class TxJournal {
  private broadcasts = 0;

  constructor(private readonly o: JournalOptions) {}

  private done(stepId: string, extra: Partial<StepRecord> = {}): void {
    this.o.steps[stepId] = { ...this.o.steps[stepId], status: 'done', at: new Date().toISOString(), ...extra };
    this.o.save();
  }

  isDone(stepId: string): boolean {
    return this.o.steps[stepId]?.status === 'done';
  }

  result(stepId: string): string | undefined {
    return this.o.steps[stepId]?.result;
  }

  private async finish(
    stepId: string,
    hash: string,
    isDone: () => Promise<boolean>,
    opts: StepOptions,
    result?: (r: TransactionReceipt) => string | undefined
  ): Promise<TransactionReceipt> {
    // Poll for the receipt rather than wait for new blocks: on a rehearsal chain no block may come
    // until this very task lets time advance.
    const deadline = Date.now() + (this.o.receiptTimeoutMs ?? 30 * 60_000);
    let r = await this.o.provider.getTransactionReceipt(hash);
    while (!r) {
      if (Date.now() > deadline) throw new Error(`no receipt for ${hash} within the timeout; re-run to resume`);
      await new Promise((res) => setTimeout(res, this.o.receiptPollMs ?? 2_000));
      r = await this.o.provider.getTransactionReceipt(hash);
    }
    if (opts.record) {
      const block = await this.o.provider.getBlock(r.blockNumber);
      opts.record.recorder.emit('tx.mined', {
        action: opts.record.action,
        tx: {
          hash: r.hash,
          from: r.from,
          gasUsed: r.gasUsed.toString(),
          effectiveGasPrice: r.gasPrice.toString(),
          feeWei: (r.gasUsed * r.gasPrice).toString(),
          status: r.status ?? 0,
          block: r.blockNumber
        },
        chainTime: block?.timestamp,
        block: r.blockNumber
      });
    }
    // The receipt and the read that follows may be served by different nodes of a load-balanced
    // RPC, and the second can lag a block behind: ask again for a while before believing "not done".
    const settled = async (): Promise<boolean> => {
      const until = Date.now() + (this.o.readLagMs ?? 30_000);
      for (;;) {
        if (await isDone()) return true;
        if (Date.now() >= until) return false;
        await new Promise((res) => setTimeout(res, Math.min(1_000, this.o.receiptPollMs ?? 2_000)));
      }
    };
    if (r.status !== 1) {
      // A revert can mean another party already did it; only chain state decides.
      if (await settled()) {
        this.done(stepId, { gasUsed: r.gasUsed.toString(), block: r.blockNumber });
        return r;
      }
      throw new Error(`step ${stepId}: transaction ${hash} reverted and the step is not done on chain; investigate before re-running`);
    }
    if (!(await settled())) throw new Error(`step ${stepId}: ${hash} succeeded but the chain does not show the step done; investigate`);
    this.done(stepId, { gasUsed: r.gasUsed.toString(), block: r.blockNumber, result: result?.(r) });
    if (opts.verbose ?? true) this.o.log(`  ${stepId.padEnd(34)} ${r.gasUsed.toString().padStart(9)} gas`);
    return r;
  }

  /**
   * One transaction step. Returns the receipt of our transaction, or null when the step was found
   * already done on chain. `result` extracts a value from the receipt to keep in the state file.
   */
  async step(
    stepId: string,
    signer: HDNodeWallet,
    req: { to: string; data?: string; value?: bigint },
    isDone: () => Promise<boolean>,
    opts: StepOptions & { result?: (r: TransactionReceipt) => string | undefined } = {}
  ): Promise<TransactionReceipt | null> {
    const { provider } = this.o;
    const rec = this.o.steps[stepId];
    if (rec?.status === 'done') {
      if (!(await isDone())) throw new Error(`step ${stepId} is recorded done but the chain disagrees; is the state file from another deployment?`);
      return null;
    }
    if (rec?.status === 'pending' && rec.tx) {
      const known = (await provider.getTransactionReceipt(rec.tx)) ?? (await provider.getTransaction(rec.tx));
      if (known) return this.finish(stepId, rec.tx, isDone, opts, opts.result);
      const used = (await provider.getTransactionCount(rec.from!, 'latest')) > rec.nonce!;
      if (used) {
        // Our nonce went to some other transaction; the chain decides whether the step happened.
        if (await isDone()) {
          this.done(stepId, { reconciled: true });
          return null;
        }
      } else {
        this.o.log(`  ${stepId}: re-broadcasting the saved transaction ${rec.tx}`);
        await provider.broadcastTransaction(rec.raw!);
        return this.finish(stepId, rec.tx, isDone, opts, opts.result);
      }
    }
    if (await isDone()) {
      if (opts.verbose ?? true) this.o.log(`  ${stepId.padEnd(34)} already on chain`);
      this.done(stepId, { reconciled: true });
      return null;
    }
    const from = signer.address;
    const fees = await waitForFeesUnderCap(provider, this.o.maxFeeWei, this.o.priorityFeeWei, { waitMs: this.o.waitMs ?? 60 * 60_000, log: this.o.log });
    const nonce = await provider.getTransactionCount(from, 'pending');
    const estimate = await provider.estimateGas({ from, to: req.to, data: req.data, value: req.value });
    const raw = await signer.signTransaction({
      type: 2,
      chainId: this.o.chainId,
      to: req.to,
      data: req.data,
      value: req.value ?? 0n,
      nonce,
      gasLimit: (estimate * (this.o.gasLimitBps ?? 13_000n)) / 10_000n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas
    });
    const hash = keccak256(raw);
    this.o.steps[stepId] = { status: 'pending', at: new Date().toISOString(), tx: hash, from, nonce, raw };
    this.o.save();
    this.broadcasts++;
    if (this.o.faults?.crashBeforeBroadcast === this.broadcasts) throw new SimulatedCrash(`simulated crash before broadcasting ${stepId}`);
    await provider.broadcastTransaction(raw);
    opts.record?.recorder.emit('tx.sent', { action: opts.record.action, hash, from, nonce });
    if (this.o.faults?.crashAfterBroadcast === this.broadcasts) throw new SimulatedCrash(`simulated crash after broadcasting ${stepId}`);
    return this.finish(stepId, hash, isDone, opts, opts.result);
  }
}

/** Runs `tasks` with at most `limit` in flight; rejects with the first failure after all settle. */
export async function inParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (err) {
        errors.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.length) throw errors[0];
}
