import type { Logger } from 'pino';
import type { ContextConfig } from './config.js';
import { newContextStatus, resetForTick, type ContextStatus } from './status.js';

/** One role's reconcile step for one context. Reads chain state and does whatever is due. */
export type Job = (status: ContextStatus) => Promise<void>;

export interface ContextRuntime {
  config: ContextConfig;
  /** Run in order on every tick; one job's failure does not stop the others. */
  jobs: { role: string; run: Job }[];
}

export interface DaemonStatus {
  startedAt: number;
  lastTickAt?: number;
  ticks: number;
  contexts: ContextStatus[];
}

/**
 * The reconcile loop. Each tick runs every context's jobs against fresh chain state; there is no
 * local state to recover after a restart beyond the tree store and the relay, which the jobs read
 * themselves. Ticks never overlap: the next one is scheduled after the previous one finishes.
 */
export class OperatorDaemon {
  private readonly statuses: ContextStatus[];
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = true;
  private readonly startedAt: number;
  private lastTickAt?: number;
  private ticks = 0;

  constructor(
    private readonly contexts: ContextRuntime[],
    private readonly log: Logger,
    private readonly intervalMs: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {
    this.statuses = contexts.map((c) => newContextStatus(c.config.name, c.config.client, c.config.roles));
    this.startedAt = this.now();
  }

  /** Runs one tick over every context. Never throws: failures are logged and kept in status. */
  async tick(): Promise<void> {
    await Promise.all(
      this.contexts.map(async (ctx, i) => {
        const status = this.statuses[i]!;
        resetForTick(status);
        const log = this.log.child({ context: ctx.config.name });
        for (const job of ctx.jobs) {
          try {
            await job.run(status);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            status.lastError = `${job.role}: ${message}`;
            log.error({ role: job.role, err }, 'job failed');
          }
        }
        status.lastTickAt = this.now();
      })
    );
    this.lastTickAt = this.now();
    this.ticks++;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      this.running = this.tick();
      await this.running;
      if (!this.stopped) this.timer = setTimeout(() => void loop(), this.intervalMs);
    };
    void loop();
  }

  /** Stops scheduling and waits for an in-flight tick to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  status(): DaemonStatus {
    return { startedAt: this.startedAt, lastTickAt: this.lastTickAt, ticks: this.ticks, contexts: this.statuses };
  }
}
