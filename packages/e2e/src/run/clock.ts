import type { JsonRpcProvider } from 'ethers';

/** Chain time as the run's tasks see it. */
export interface Clock {
  /** Timestamp of the latest block. */
  now(): Promise<number>;
  /** Resolves once chain time is at least `t`. */
  until(t: number): Promise<void>;
  /** Registers a task that will call `until`; time only fast-forwards when every task waits. */
  join(): void;
  leave(): void;
}

async function head(provider: JsonRpcProvider): Promise<number> {
  const b = await provider.getBlock('latest');
  if (!b) throw new Error('no latest block');
  return b.timestamp;
}

/** Real time: waits for the chain to reach `t`, polling the head. */
export class RealClock implements Clock {
  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly pollMs = 12_000
  ) {}
  now(): Promise<number> {
    return head(this.provider);
  }
  async until(t: number): Promise<void> {
    for (;;) {
      const now = await this.now();
      if (now >= t) return;
      await new Promise((r) => setTimeout(r, Math.min(this.pollMs, Math.max(1000, (t - now) * 1000))));
    }
  }
  join(): void {}
  leave(): void {}
}

/**
 * Rehearsal time on a local anvil: when every registered task is waiting in `until`, chain time
 * jumps to the earliest time any of them waits for (evm_increaseTime + evm_mine). Tasks that wait
 * for something else (a daemon posting a root) keep time still, so daemons always get to act at
 * the chain time they would see on a real chain.
 */
export class FastClock implements Clock {
  private tasks = 0;
  private readonly waiters: { t: number; resolve: () => void }[] = [];
  private advancing = false;

  constructor(private readonly provider: JsonRpcProvider) {}

  now(): Promise<number> {
    return head(this.provider);
  }
  join(): void {
    this.tasks++;
  }
  leave(): void {
    this.tasks--;
    void this.maybeAdvance();
  }
  async until(t: number): Promise<void> {
    if ((await this.now()) >= t) return;
    await new Promise<void>((resolve) => {
      this.waiters.push({ t, resolve });
      void this.maybeAdvance();
    });
  }

  private async maybeAdvance(): Promise<void> {
    if (this.advancing || this.waiters.length === 0 || this.waiters.length < this.tasks) return;
    this.advancing = true;
    try {
      const target = Math.min(...this.waiters.map((w) => w.t));
      const now = await this.now();
      if (target > now) await this.provider.send('evm_increaseTime', [target - now]);
      await this.provider.send('evm_mine', []);
      const reached = await this.now();
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i]!.t <= reached) this.waiters.splice(i, 1)[0]!.resolve();
      }
    } finally {
      this.advancing = false;
    }
    if (this.waiters.length > 0) void this.maybeAdvance();
  }
}
