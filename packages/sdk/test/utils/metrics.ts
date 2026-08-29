import * as fs from 'fs';
import { performance } from 'perf_hooks';
import type { TransactionReceipt } from 'ethers';

export async function measureAndLogMetric<T>(
  label: string,
  txReceiptPromise: Promise<TransactionReceipt | null>,
  computeTask?: () => Promise<T>
): Promise<T | void> {
  const start = performance.now();

  let computeResult: T | undefined;
  if (computeTask) {
    computeResult = await computeTask();
  }

  const receipt = await txReceiptPromise;
  const durationMs = Math.round(performance.now() - start);

  const metric = {
    label,
    gasUsed: receipt?.gasUsed?.toString() || '0',
    txHash: receipt?.hash || 'offline-task',
    blockNumber: receipt?.blockNumber || 0,
    durationMs
  };

  fs.appendFileSync('metrics.jsonl', JSON.stringify(metric) + '\n');

  return computeResult;
}
