import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { validateEvent, type RecorderEvent } from '@drift-network/operator';

/** One problem found while loading, reported in the data-quality table; nothing is dropped silently. */
export interface QualityIssue {
  kind: 'invalid_json' | 'invalid_event' | 'seq_gap' | 'seq_repeat' | 'tx_without_receipt' | 'negative_latency' | 'mixed_process';
  file: string;
  line?: number;
  detail: string;
}

export interface LoadedEvent {
  event: RecorderEvent;
  /** File the line came from, relative to its input directory, for reporting. */
  file: string;
  line: number;
}

export interface LoadResult {
  events: LoadedEvent[];
  files: { file: string; lines: number; valid: number }[];
  issues: QualityIssue[];
}

/** Every *.jsonl file under `dir`, recursively, in a fixed (sorted) order. */
function jsonlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Reads recorder logs from `dirs`. Each line is parsed and checked with the operator's
 * validateEvent; invalid lines are reported, not used. Each file is one process (JsonlSink names
 * files `<runId>.<process>.<pid>.jsonl`), so its `seq` must run 1, 2, 3, ...: a gap means lost lines,
 * a repeat or decrease means reordered or duplicated ones. Both are reported; the valid events are
 * still used.
 */
export function loadEvents(dirs: string[]): LoadResult {
  const events: LoadedEvent[] = [];
  const files: LoadResult['files'] = [];
  const issues: QualityIssue[] = [];
  for (const [d, dir] of dirs.entries()) {
    for (const path of jsonlFiles(dir)) {
      const file = dirs.length > 1 ? `${d}:${relative(dir, path)}` : relative(dir, path);
      const lines = readFileSync(path, 'utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      let valid = 0;
      let lastSeq = 0;
      const processes = new Set<string>();
      lines.forEach((text, i) => {
        const line = i + 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          issues.push({ kind: 'invalid_json', file, line, detail: 'line is not JSON' });
          return;
        }
        const errors = validateEvent(parsed);
        if (errors.length) {
          issues.push({ kind: 'invalid_event', file, line, detail: errors.join('; ') });
          return;
        }
        const e = parsed as RecorderEvent;
        processes.add(e.process);
        if (e.seq > lastSeq + 1) issues.push({ kind: 'seq_gap', file, line, detail: `seq ${lastSeq} -> ${e.seq}: ${e.seq - lastSeq - 1} line(s) missing` });
        else if (e.seq <= lastSeq) issues.push({ kind: 'seq_repeat', file, line, detail: `seq ${e.seq} after ${lastSeq}` });
        lastSeq = Math.max(lastSeq, e.seq);
        valid++;
        events.push({ event: e, file, line });
      });
      if (processes.size > 1) issues.push({ kind: 'mixed_process', file, detail: `file holds ${processes.size} processes: ${[...processes].sort().join(', ')}` });
      files.push({ file, lines: lines.length, valid });
    }
  }
  return { events, files, issues };
}
