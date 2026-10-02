/**
 * Percentiles use the nearest-rank method (as fees.ts does for fee history): for p in (0, 100] the value at rank ceil(p/100 * n) of
 * the ascending sample (1-based). It always returns an observed value and needs no interpolation,
 * so tables are exact and reproducible; the median is the lower middle value when n is even.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of an empty sample');
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export interface Summary {
  n: number;
  median: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
}

export function summarize(values: number[]): Summary {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: percentile(s, 50), p90: percentile(s, 90), p99: percentile(s, 99), min: s[0]!, max: s[s.length - 1]! };
}

/** Same as summarize, for integer quantities kept exact as bigint (gas, wei). */
export interface BigSummary {
  n: number;
  median: bigint;
  min: bigint;
  max: bigint;
  total: bigint;
}

export function summarizeBig(values: bigint[]): BigSummary {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.max(1, Math.ceil(0.5 * s.length));
  return { n: s.length, median: s[rank - 1]!, min: s[0]!, max: s[s.length - 1]!, total: s.reduce((a, b) => a + b, 0n) };
}

/** Plain decimal with `digits` fraction digits, no grouping: for CSV. */
export const fixed = (v: number, digits: number): string => (Object.is(v, -0) ? 0 : v).toFixed(digits);

/** Integer part grouped with LaTeX `{,}` (125{,}375), as in the dissertation. */
export function texNumber(v: number | bigint, digits = 0): string {
  const s = typeof v === 'bigint' ? v.toString() : fixed(v, digits);
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, '{,}');
  return (neg ? '-' : '') + grouped + (frac !== undefined ? `.${frac}` : '');
}

/** wei to ETH with exactly `digits` fraction digits, computed in integers (no float rounding). */
export function weiToEth(wei: bigint, digits = 6): string {
  const scale = 10n ** BigInt(18 - digits);
  const rounded = (wei + scale / 2n) / scale;
  const s = rounded.toString().padStart(digits + 1, '0');
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** Escapes text for a LaTeX table cell. */
export const texEscape = (s: string): string => s.replace(/\\/g, '\\textbackslash{}').replace(/([_%&#$])/g, '\\$1');
