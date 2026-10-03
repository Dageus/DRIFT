import { describe, expect, it } from 'vitest';
import { Wallet, type JsonRpcProvider } from 'ethers';
import { TxJournal, type JournalOptions } from '../../src/journal.js';

const HASH = '0x' + 'ab'.repeat(32);

/** A journal resuming one pending step whose transaction is already mined with `status`. */
function resuming(status: number, readLagMs: number) {
  const provider = {
    getTransactionReceipt: async () => ({ hash: HASH, status, gasUsed: 21_000n, gasPrice: 1n, blockNumber: 7, from: '0x' + '11'.repeat(20) })
  } as unknown as JsonRpcProvider;
  const steps: JournalOptions['steps'] = { s: { status: 'pending', tx: HASH } as JournalOptions['steps'][string] };
  const journal = new TxJournal({ provider, chainId: 1n, steps, save: () => {}, maxFeeWei: 1n, priorityFeeWei: 1n, log: () => {}, receiptPollMs: 1, readLagMs });
  const signer = Wallet.createRandom();
  return { journal, steps, run: (isDone: () => Promise<boolean>) => journal.step('s', signer, { to: '0x' + '22'.repeat(20) }, isDone, { verbose: false }) };
}

describe('TxJournal read lag', () => {
  it('re-reads chain state after a receipt until a lagging node catches up', async () => {
    const { run, steps } = resuming(1, 5_000);
    let reads = 0;
    // The first two reads come from a node one block behind the receipt.
    await run(async () => ++reads > 2);
    expect(reads).toBe(3);
    expect(steps.s!.status).toBe('done');
  });

  it('still fails a mined step the chain never shows done', async () => {
    const { run, steps } = resuming(1, 20);
    await expect(run(async () => false)).rejects.toThrow(/succeeded but the chain does not show the step done/);
    expect(steps.s!.status).toBe('pending');
  });

  it('still fails a reverted step that is not done', async () => {
    const { run } = resuming(0, 20);
    await expect(run(async () => false)).rejects.toThrow(/reverted and the step is not done on chain/);
  });
});
