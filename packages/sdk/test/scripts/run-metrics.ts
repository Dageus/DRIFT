#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'fs';

interface Metric {
  label: string;
  gasUsed: string;
  gasPrice?: string;
  txHash: string;
  blockNumber: number;
  durationMs: number;
}

function parseMetrics(filePath: string): Metric[] {
  const content = readFileSync(filePath, 'utf-8');
  const metrics: Metric[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      metrics.push(JSON.parse(line));
    } catch (e) {
      console.error('Failed to parse line:', line);
    }
  }
  return metrics;
}

function toLatexTable(metrics: Metric[]): string {
  const rows = metrics
    .map(
      (m) =>
        `  ${m.label} & ${m.gasUsed} & ${m.durationMs} & \texttt{${m.txHash.slice(0, 12)}...} \\
`
    )
    .join('');

  return `
\begin{table}[h]
\centering
\begin{tabular}{lrrl}
\toprule
\textbf{Operation} & \textbf{Gas Used} & \textbf{Latency (ms)} & \textbf{Tx Hash} \\
\midrule
${rows}\bottomrule
\end{tabular}
\caption{DRIFT Protocol Gas \& Latency Metrics (Sepolia Testnet)}
\label{tab:drift-metrics}
\end{table}
`.trim();
}

function toCSV(metrics: Metric[]): string {
  const header = 'operation,gas_used,latency_ms,tx_hash,block_number';
  const rows = metrics.map((m) => `${m.label},${m.gasUsed},${m.durationMs},${m.txHash},${m.blockNumber}`);
  return [header, ...rows].join('\n');
}

const filePath = process.argv[2] || 'metrics.jsonl';
const metrics = parseMetrics(filePath);

if (metrics.length === 0) {
  console.error(`No metrics found in ${filePath}`);
  process.exit(1);
}

writeFileSync('metrics-table.tex', toLatexTable(metrics));
writeFileSync('metrics.csv', toCSV(metrics));

console.log(`Wrote ${metrics.length} metrics to metrics-table.tex and metrics.csv`);
