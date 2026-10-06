// Offline analysis of recorder event logs into the dissertation's tables and plot data.
export { loadEvents } from './load.js';
export type { LoadResult, LoadedEvent, QualityIssue } from './load.js';
export { analyze, contextGroups, dedupe, latencySamples, eventOrder } from './analyze.js';
export type { Analysis, LatencySample, LatencyRow, GasRow, EpochCostRow, TierCostRow, RoundRow, TimelineRow } from './analyze.js';
export { renderFiles, writeFiles, stableJson } from './render.js';
export { indexerCheck } from './indexer.js';
export type { IndexerCheckParams, IndexerCheckRow } from './indexer.js';
export { summarize, texNumber, weiToEth } from './stats.js';
