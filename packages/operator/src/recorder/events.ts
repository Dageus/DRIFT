// Event schema of the operator recorder, version 1. One JSON object per line (JSONL). The
// dissertation's evaluation is computed from these logs, so the schema is versioned and checked:
// add an event type or an optional field freely; change or remove a field only with a new `v`.

export const RECORDER_SCHEMA_VERSION = 1;

export type Tier = 'tier1' | 'tier2' | 'watcher' | 'client';

/** Fields every event carries. */
export interface BaseEvent {
  v: typeof RECORDER_SCHEMA_VERSION;
  type: EventType;
  runId: string;
  /** Name of the writing process (one JSONL file per process). */
  process: string;
  /** Monotonic per process, from 1: detects lost or reordered lines. */
  seq: number;
  /** Wall clock, Unix milliseconds. */
  wallMs: number;
  context?: string;
  tier?: Tier;
  epoch?: string;
  round?: string;
  /** Chain time in Unix seconds, when the event is about a chain instant (see each type). */
  chainTime?: number;
  block?: number;
}

/** Receipt data of a mined transaction. Amounts are decimal strings. */
export interface TxInfo {
  hash: string;
  from: string;
  gasUsed: string;
  /** Effective gas price paid, wei (receipt.gasPrice: base fee plus the priority fee paid). */
  effectiveGasPrice: string;
  /** gasUsed x effectiveGasPrice, wei. */
  feeWei: string;
  status: number;
  block: number;
}

/**
 * Every event type, with the fields it adds to BaseEvent. `chainTime` meanings are listed where
 * set. Durations measured inside one step are in milliseconds (`...Ms`).
 */
export const EVENT_FIELDS = {
  // Settlement, tiers 1 and 2. ------------------------------------------------------------
  /** The job first saw this epoch due: boundary passed, previous epoch final. chainTime = t_E. */
  'epoch.due': { required: ['epoch'], optional: [] },
  /** O1 check before a snapshot. chainTime = timestamp of the head checked. */
  'o1.checked': { required: ['epoch', 'synced', 'boundary'], optional: [] },
  /** Snapshot built: attestations and members at t_E. */
  'snapshot.done': { required: ['epoch', 'records', 'rawRecords', 'members', 'durationMs'], optional: [] },
  /** Phi_c computed. `nodes` is N, the engine's node count; `step` names the Tier 2 step. */
  'root.computed': { required: ['epoch', 'root', 'nodes', 'members', 'durationMs'], optional: ['step', 'inputDigest', 'proposalId'] },
  'tree.uploaded': { required: ['epoch', 'root', 'treeURI', 'leaves', 'durationMs'], optional: ['proposalId'] },
  'tree.pinned': { required: ['epoch', 'treeURI', 'durationMs'], optional: ['proposalId'] },
  /** A settlement root accepted on chain for this epoch, as the job learned it. */
  'settle.posted': { required: ['epoch', 'root'], optional: ['treeURI', 'txHash'] },
  /** The job first saw this epoch's root on chain. chainTime = postedAt. */
  'epoch.posted': { required: ['epoch', 'root', 'disputeWindowEndsAt'], optional: [] },
  /** The job first saw this epoch finalized. chainTime = head timestamp at that moment. */
  'epoch.finalized': { required: ['epoch'], optional: [] },
  'bond.withdrawn': { required: ['epoch'], optional: [] },

  // Tier 2 rounds. ------------------------------------------------------------------------
  'tier2.proposed': { required: ['epoch', 'round', 'proposalId', 'commitDeadline', 'revealDeadline'], optional: [] },
  'tier2.committed': { required: ['epoch', 'round', 'proposalId', 'owner'], optional: [] },
  'tier2.revealed': { required: ['epoch', 'round', 'proposalId', 'owner', 'seen'], optional: [] },
  'tier2.published': { required: ['epoch', 'round', 'proposalId', 'root', 'treeURI'], optional: [] },
  'tier2.signed': { required: ['epoch', 'round', 'proposalId', 'owner'], optional: [] },
  'tier2.executed': { required: ['epoch', 'round', 'proposalId'], optional: ['signatures'] },
  /** First time this process saw the round's outcome (agreed or dead). */
  'tier2.round_outcome': { required: ['epoch', 'round', 'proposalId', 'outcome'], optional: [] },

  // Disputes (settler side). --------------------------------------------------------------
  /** chainTime = head timestamp when detected; openedAt and deadline are chain seconds. */
  'challenge.detected': { required: ['epoch', 'node', 'role', 'openedAt', 'deadline'], optional: [] },
  'challenge.answered': { required: ['epoch', 'node', 'role'], optional: [] },
  'challenge.unanswerable': { required: ['epoch', 'node', 'role'], optional: [] },
  'challenge.expired': { required: ['epoch', 'node', 'role'], optional: [] },

  // Watcher. ------------------------------------------------------------------------------
  /** chainTime = postedAt. */
  'watch.root_seen': { required: ['epoch', 'root'], optional: [] },
  'watch.recomputed': { required: ['epoch', 'postedRoot', 'ourRoot', 'agrees', 'treeAvailable', 'omitted', 'durationMs'], optional: [] },
  /** chainTime = head timestamp at detection. postedAt in chain seconds. */
  'watch.divergence': { required: ['epoch', 'postedRoot', 'ourRoot', 'omitted', 'postedAt'], optional: [] },
  'watch.challenge_opened': { required: ['epoch', 'node', 'role', 'bond'], optional: [] },
  'watch.challenge_skipped': { required: ['epoch', 'reason'], optional: [] },
  /** An unanswered challenge claimed (driver or operator). */
  'challenge.claimed': { required: ['epoch', 'node', 'role'], optional: [] },

  // Transactions, from any key the process sends with. ----------------------------------
  /** `action` names what the tx does (settle.post, challenge.respond, ...). */
  'tx.sent': { required: ['action', 'hash', 'from'], optional: ['nonce'] },
  /** chainTime = timestamp of the including block. */
  'tx.mined': { required: ['action', 'tx'], optional: [] },

  // Client side, emitted by the experiment driver. ----------------------------------------
  'client.attest': { required: ['attester', 'subjects'], optional: [] },
  /** proofFetchMs: time to get the proof; proofDepth: sibling count. */
  'client.claim': { required: ['node', 'role', 'proofFetchMs', 'proofDepth'], optional: [] },
  'client.vote': { required: ['node', 'proposalId', 'proofFetchMs', 'proofDepth'], optional: [] }
} as const satisfies Record<string, { required: readonly string[]; optional: readonly string[] }>;

export type EventType = keyof typeof EVENT_FIELDS;
export const EVENT_TYPES = Object.keys(EVENT_FIELDS) as EventType[];

export type RecorderEvent = BaseEvent & Record<string, unknown>;

const BASE_REQUIRED = ['v', 'type', 'runId', 'process', 'seq', 'wallMs'] as const;
const BASE_OPTIONAL = ['context', 'tier', 'epoch', 'round', 'chainTime', 'block'] as const;
const TIERS: Tier[] = ['tier1', 'tier2', 'watcher', 'client'];

/** Returns every problem with `e` as a v1 event; empty when it is valid. */
export function validateEvent(e: unknown): string[] {
  const errors: string[] = [];
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return ['not an object'];
  const o = e as Record<string, unknown>;
  for (const k of BASE_REQUIRED) if (o[k] === undefined) errors.push(`missing ${k}`);
  if (o.v !== RECORDER_SCHEMA_VERSION) errors.push(`unsupported schema version ${String(o.v)}`);
  const spec = EVENT_FIELDS[o.type as EventType] as { required: readonly string[]; optional: readonly string[] } | undefined;
  if (!spec) return [...errors, `unknown event type ${String(o.type)}`];
  for (const k of spec.required) if (o[k] === undefined) errors.push(`${String(o.type)}: missing ${k}`);
  const known = new Set<string>([...BASE_REQUIRED, ...BASE_OPTIONAL, ...spec.required, ...spec.optional]);
  for (const k of Object.keys(o)) if (!known.has(k)) errors.push(`${String(o.type)}: unexpected field ${k}`);
  if (typeof o.seq !== 'number' || !Number.isInteger(o.seq) || o.seq < 1) errors.push('seq must be a positive integer');
  if (typeof o.wallMs !== 'number') errors.push('wallMs must be a number');
  if (o.chainTime !== undefined && typeof o.chainTime !== 'number') errors.push('chainTime must be a number');
  if (o.tier !== undefined && !TIERS.includes(o.tier as Tier)) errors.push(`unknown tier ${JSON.stringify(o.tier)}`);
  for (const k of ['epoch', 'round'] as const) if (o[k] !== undefined && typeof o[k] !== 'string') errors.push(`${k} must be a decimal string`);
  if (o.type === 'tx.mined') {
    const tx = o.tx as Record<string, unknown> | undefined;
    for (const k of ['hash', 'from', 'gasUsed', 'effectiveGasPrice', 'feeWei', 'status', 'block']) {
      if (tx?.[k] === undefined) errors.push(`tx.mined: missing tx.${k}`);
    }
  }
  return errors;
}

// LATENCIES ======================================================================================

/** How an event sequence is keyed for pairing: events with the same key belong together. */
export type PairKey = 'epoch' | 'round' | 'tx' | 'challenge';

/**
 * A latency derived from the events, shared by the live metrics and the offline analysis so both
 * report the same numbers. `single`: computed from one event. `pair`: the time between the first
 * `from` and the first `to` event with the same key, on the wall or the chain clock.
 */
export type LatencyDef =
  | { name: string; help: string; unit: 'seconds'; kind: 'single'; event: EventType; value: (e: RecorderEvent) => number | undefined }
  | {
      name: string;
      help: string;
      unit: 'seconds';
      kind: 'pair';
      from: EventType;
      to: EventType;
      key: PairKey;
      clock: 'wall' | 'chain';
      /** Only `from`/`to` events passing this filter count (e.g. one tx action). */
      where?: (e: RecorderEvent) => boolean;
      /** Extra metric labels, taken from the `to` event. */
      labels?: (e: RecorderEvent) => Record<string, string>;
    };

const ms = (field: string) => (e: RecorderEvent) => (typeof e[field] === 'number' ? (e[field]) / 1000 : undefined);

export const LATENCIES: LatencyDef[] = [
  { name: 'o1_wait', help: 'Chain time from t_E to the finalized head the snapshot was taken at.', unit: 'seconds', kind: 'pair', from: 'epoch.due', to: 'o1.checked', key: 'epoch', clock: 'chain', where: (e) => e.type !== 'o1.checked' || e.synced === true },
  { name: 'snapshot', help: 'Building the snapshot (attestations and membership at t_E).', unit: 'seconds', kind: 'single', event: 'snapshot.done', value: ms('durationMs') },
  { name: 'compute', help: 'Computing Phi_c over the snapshot.', unit: 'seconds', kind: 'single', event: 'root.computed', value: ms('durationMs') },
  { name: 'tree_upload', help: 'Uploading the settlement tree.', unit: 'seconds', kind: 'single', event: 'tree.uploaded', value: ms('durationMs') },
  { name: 'tree_pin', help: 'Pinning the settlement tree.', unit: 'seconds', kind: 'single', event: 'tree.pinned', value: ms('durationMs') },
  { name: 'settle_total', help: 'Wall time from the epoch falling due to its root accepted on chain.', unit: 'seconds', kind: 'pair', from: 'epoch.due', to: 'settle.posted', key: 'epoch', clock: 'wall' },
  { name: 'tx_inclusion', help: 'Wall time from sending a transaction to its receipt.', unit: 'seconds', kind: 'pair', from: 'tx.sent', to: 'tx.mined', key: 'tx', clock: 'wall', labels: (e) => ({ action: String(e.action) }) },
  { name: 'finalization', help: 'Chain time from posting to the job seeing the epoch finalized.', unit: 'seconds', kind: 'pair', from: 'epoch.posted', to: 'epoch.finalized', key: 'epoch', clock: 'chain' },
  { name: 'bond_withdrawal', help: 'Wall time from seeing the epoch finalized to the bond withdrawn.', unit: 'seconds', kind: 'pair', from: 'epoch.finalized', to: 'bond.withdrawn', key: 'epoch', clock: 'wall' },
  { name: 'tier2_round', help: 'Wall time from a round proposed to its outcome observed.', unit: 'seconds', kind: 'pair', from: 'tier2.proposed', to: 'tier2.round_outcome', key: 'round', clock: 'wall' },
  { name: 'challenge_detection', help: 'Chain time from a challenge opening to the settler detecting it.', unit: 'seconds', kind: 'single', event: 'challenge.detected', value: (e) => (typeof e.chainTime === 'number' ? e.chainTime - Number(e.openedAt) : undefined) },
  { name: 'challenge_response', help: 'Wall time from detecting a challenge to its answer recorded.', unit: 'seconds', kind: 'pair', from: 'challenge.detected', to: 'challenge.answered', key: 'challenge', clock: 'wall' },
  { name: 'watch_detection', help: 'Chain time from a root posted to the watcher detecting divergence.', unit: 'seconds', kind: 'single', event: 'watch.divergence', value: (e) => (typeof e.chainTime === 'number' ? e.chainTime - Number(e.postedAt) : undefined) },
  { name: 'watch_recompute', help: 'Watcher recomputation of a posted epoch.', unit: 'seconds', kind: 'single', event: 'watch.recomputed', value: ms('durationMs') }
];

/** Key of `e` for a pair latency, or undefined when the event lacks what the key needs. */
export function pairKey(e: RecorderEvent, key: PairKey): string | undefined {
  const base = `${e.runId}|${e.context ?? ''}|${e.tier ?? ''}`;
  switch (key) {
    case 'epoch':
      return e.epoch === undefined ? undefined : `${base}|${e.epoch}`;
    case 'round':
      return e.epoch === undefined || e.round === undefined ? undefined : `${base}|${e.epoch}|${e.round}`;
    case 'tx': {
      const hash = e.type === 'tx.mined' ? (e.tx as TxInfo | undefined)?.hash : (e.hash as string | undefined);
      return hash ? `${e.runId}|${hash.toLowerCase()}` : undefined;
    }
    case 'challenge':
      return e.epoch === undefined || e.node === undefined ? undefined : `${base}|${e.epoch}|${(e.node as string).toLowerCase()}|${String(e.role)}`;
  }
}

/** The instant of `e` on a clock, in seconds. */
export function instant(e: RecorderEvent, clock: 'wall' | 'chain'): number | undefined {
  return clock === 'wall' ? e.wallMs / 1000 : e.chainTime;
}
