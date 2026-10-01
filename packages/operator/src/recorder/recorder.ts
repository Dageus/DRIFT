import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, type Provider, type TransactionRequest, type TransactionResponse } from 'ethers';
import type { Logger } from 'pino';
import { RECORDER_SCHEMA_VERSION, type EventType, type RecorderEvent, type Tier, type TxInfo } from './events.js';

/** Receives every recorded event. A sink may throw; the recorder contains it. */
export interface EventSink {
  write(e: RecorderEvent): void;
}

/** Context, tier, epoch and round an event belongs to. */
export interface Scope {
  context?: string;
  tier?: Tier;
  epoch?: bigint | string;
  round?: bigint | string;
}

/**
 * Optional hook the pipeline steps call at their milestones. Never throws: steps call it through
 * emitTrace, and a failing recorder must not change what a step does.
 */
export type Trace = (type: EventType, fields?: Record<string, unknown>) => void;

export function emitTrace(trace: Trace | undefined, type: EventType, fields?: Record<string, unknown>): void {
  if (!trace) return;
  try {
    trace(type, fields);
  } catch {
    // Recording is best effort by design.
  }
}

/**
 * Appends events as JSON lines to one file per process and fsyncs after each line, so an event
 * the process has recorded survives a crash. Never share a file between processes: the file name
 * carries the process name and pid.
 */
export class JsonlSink implements EventSink {
  readonly path: string;
  private fd: number | null;

  constructor(dir: string, runId: string, processName: string) {
    mkdirSync(dir, { recursive: true });
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
    this.path = join(dir, `${safe(runId)}.${safe(processName)}.${process.pid}.jsonl`);
    this.fd = openSync(this.path, 'a');
  }

  write(e: RecorderEvent): void {
    if (this.fd === null) throw new Error('recorder file is closed');
    writeSync(this.fd, JSON.stringify(e) + '\n');
    fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

/** Keeps events in memory, for tests and for the offline analysis of a single process. */
export class MemorySink implements EventSink {
  readonly events: RecorderEvent[] = [];
  write(e: RecorderEvent): void {
    this.events.push(e);
  }
}

interface ActionContext {
  recorder: ScopedRecorder;
  action: string;
}

const actions = new AsyncLocalStorage<ActionContext>();

const str = (v: bigint | string | undefined) => (v === undefined ? undefined : v.toString());

/**
 * Process-level recorder: stamps every event with the schema version, run id, process name,
 * sequence number and wall time, and fans it out to its sinks. A sink failure is logged once per
 * sink and otherwise ignored: recording must never break the operator.
 */
export class Recorder {
  private seq = 0;
  private readonly failed = new Set<EventSink>();

  constructor(
    private readonly sinks: EventSink[],
    readonly runId: string,
    readonly processName: string,
    private readonly log?: Logger,
    private readonly now: () => number = Date.now
  ) {}

  emit(scope: Scope, type: EventType, fields: Record<string, unknown> = {}): void {
    let event: RecorderEvent;
    try {
      event = {
        v: RECORDER_SCHEMA_VERSION,
        type,
        runId: this.runId,
        process: this.processName,
        seq: ++this.seq,
        wallMs: this.now(),
        ...(scope.context !== undefined && { context: scope.context }),
        ...(scope.tier !== undefined && { tier: scope.tier }),
        ...(scope.epoch !== undefined && { epoch: str(scope.epoch) }),
        ...(scope.round !== undefined && { round: str(scope.round) }),
        ...normalize(fields)
      };
    } catch (err) {
      this.log?.warn({ err, type }, 'recorder: could not build event');
      return;
    }
    for (const sink of this.sinks) {
      try {
        sink.write(event);
      } catch (err) {
        if (!this.failed.has(sink)) this.log?.warn({ err, type }, 'recorder: sink failed; continuing without this event');
        this.failed.add(sink);
      }
    }
  }

  scope(scope: Scope = {}): ScopedRecorder {
    return new ScopedRecorder(this, scope);
  }
}

/** bigint to decimal string, recursively; other values as they are. */
function normalize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map((x) => (typeof x === 'bigint' ? x.toString() : x)) : v;
  }
  for (const k of ['epoch', 'round'] as const) {
    const v = out[k];
    if (typeof v === 'number' || typeof v === 'bigint') out[k] = v.toString();
  }
  return out;
}

/** A recorder bound to a scope. Every method is safe to call: none throws. */
export class ScopedRecorder {
  private readonly seen = new Set<string>();

  constructor(
    private readonly root: Recorder | null,
    readonly scope: Scope
  ) {}

  /** False for NOOP_RECORDER: callers skip reads they would make only to record. */
  get active(): boolean {
    return this.root !== null;
  }

  with(extra: Scope): ScopedRecorder {
    return new ScopedRecorder(this.root, { ...this.scope, ...extra });
  }

  emit(type: EventType, fields: Record<string, unknown> = {}): void {
    if (!this.root) return;
    const { epoch, round, ...rest } = fields as { epoch?: bigint | string; round?: bigint | string };
    try {
      this.root.emit({ ...this.scope, ...(epoch !== undefined && { epoch }), ...(round !== undefined && { round }) }, type, rest);
    } catch {
      // Recorder.emit already contains its own failures; this is a last guard.
    }
  }

  /**
   * Emits only the first time `key` is seen by this scoped recorder (per process): for "first
   * observed" events, such as an epoch falling due or finalizing, that a job sees on every tick.
   */
  once(key: string, type: EventType, fields: Record<string, unknown> = {}): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.emit(type, fields);
  }

  /** The Trace a pipeline step takes, emitting into this scope. */
  get trace(): Trace {
    return (type, fields) => this.emit(type, fields);
  }

  /**
   * Runs `fn` with `action` as the label of every transaction a RecordingWallet sends inside it,
   * and `fields` (epoch, round) merged into this scope for those transaction events.
   */
  action<T>(action: string, fn: () => Promise<T>, fields: Scope = {}): Promise<T> {
    return actions.run({ recorder: this.with(fields), action }, fn);
  }
}

/** A recorder that drops everything, the default when recording is off. */
export const NOOP_RECORDER = new ScopedRecorder(null, {});

/**
 * Polls for a receipt. Not waitForTransaction: that waits for new-block events, which an idle
 * chain (a local anvil between test steps) may never produce. Gives up after `timeoutMs`.
 */
async function pollReceipt(provider: Provider, hash: string, intervalMs = 1000, timeoutMs = 3_600_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const receipt = await provider.getTransactionReceipt(hash).catch(() => null);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, intervalMs).unref());
  }
  return null;
}

/**
 * A Wallet that records `tx.sent` and, once the receipt arrives, `tx.mined` with its gas and
 * effective gas price. The action label and scope come from the enclosing
 * ScopedRecorder.action; transactions sent outside one are recorded as action 'other' under
 * `fallback`.
 */
export class RecordingWallet extends Wallet {
  constructor(
    key: string,
    provider: Provider,
    private readonly fallback: ScopedRecorder
  ) {
    super(key, provider);
  }

  override async sendTransaction(req: TransactionRequest): Promise<TransactionResponse> {
    const ctx = actions.getStore() ?? { recorder: this.fallback, action: 'other' };
    const tx = await super.sendTransaction(req);
    ctx.recorder.emit('tx.sent', { action: ctx.action, hash: tx.hash, from: tx.from, nonce: tx.nonce });
    // Watch for the receipt independently of the caller: ethers' Contract wraps this response in
    // a new object, so patching its wait() would miss contract calls. A reverted transaction has a
    // receipt too, and is recorded with status 0.
    const provider = this.provider;
    if (!provider) return tx;
    void pollReceipt(provider, tx.hash)
      .then(async (receipt) => {
        if (!receipt) return;
        const block = await provider.getBlock(receipt.blockNumber);
        const info: TxInfo = {
          hash: receipt.hash,
          from: receipt.from,
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.gasPrice.toString(),
          feeWei: (receipt.gasUsed * receipt.gasPrice).toString(),
          status: receipt.status ?? 0,
          block: receipt.blockNumber
        };
        ctx.recorder.emit('tx.mined', { action: ctx.action, tx: info, chainTime: block?.timestamp, block: receipt.blockNumber });
      })
      .catch(() => {
        // Best effort: a dropped or replaced transaction simply has no tx.mined.
      });
    return tx;
  }
}
