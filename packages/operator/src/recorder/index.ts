// Recorder: an append-only, versioned JSONL event log of everything the operator does, with
// Prometheus metrics derived from the same events. The e2e driver reuses it for client events.
export {
  RECORDER_SCHEMA_VERSION,
  EVENT_FIELDS,
  EVENT_TYPES,
  LATENCIES,
  validateEvent,
  pairKey,
  instant
} from './events.js';
export type { BaseEvent, EventType, RecorderEvent, Tier, TxInfo, LatencyDef, PairKey } from './events.js';
export { Recorder, ScopedRecorder, NOOP_RECORDER, JsonlSink, MemorySink, RecordingWallet, emitTrace } from './recorder.js';
export type { EventSink, Scope, Trace } from './recorder.js';
export { MetricsSink } from './metrics.js';
