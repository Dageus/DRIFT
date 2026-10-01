import type { Role } from './config.js';

export type AlertLevel = 'warn' | 'error';

export interface Alert {
  level: AlertLevel;
  message: string;
  /** Chain timestamp, or wall-clock seconds when no chain time was available. */
  at: number;
}

export interface ChallengeStatus {
  epoch: string;
  node: string;
  role: string;
  deadline: string;
  state: 'answered' | 'pending' | 'unanswerable' | 'expired';
}

export interface Tier2RoundStatus {
  epoch: string;
  proposalId: string;
  steps: Record<'propose' | 'commit' | 'reveal' | 'publish' | 'sign' | 'execute', string>;
}

/** A watcher's check of one posted root against its own recomputation. */
export interface WatchFinding {
  epoch: string;
  postedRoot: string;
  ourRoot: string;
  ourInputDigest: string;
  /**
   * Input digest behind the posted root, when the watcher can learn it (a Tier 2 relay records
   * it). The chain stores only the root, so for a Tier 1 settler it is unknown.
   */
  postedInputDigest?: string;
  agrees: boolean;
  /** Whether the posted tree could be retrieved from its treeURI and matched the root. */
  treeAvailable: boolean;
  /** Pairs in the watcher's own member set with no leaf in the posted tree. */
  omitted: { node: string; role: string }[];
  challenged?: { node: string; role: string };
  /** Why no challenge was opened although pairs are omitted (window closed, no standing). */
  challengeSkipped?: string;
}

/** What /status reports for one context. Rebuilt from chain state on every tick, never persisted. */
export interface ContextStatus {
  name: string;
  client: string;
  roles: Role[];
  contextUID?: string;
  currentEpoch?: string;
  lastSettled?: { epoch: string; root: string; treeURI: string; txHash: string };
  challenges: ChallengeStatus[];
  /** pendingPayouts(trustedSettler): owed to the settler, collectable only with its own key. */
  pendingPayout?: string;
  tier2?: Tier2RoundStatus;
  watch?: WatchFinding;
  /** Human-readable description of what the daemon is waiting for or will do next. */
  nextAction?: string;
  /** Problems found on the latest tick. Errors mean money or liveness is at risk. */
  alerts: Alert[];
  lastError?: string;
  lastTickAt?: number;
}

export function newContextStatus(name: string, client: string, roles: Role[]): ContextStatus {
  return { name, client, roles, challenges: [], alerts: [] };
}

/** Clears the per-tick fields; `lastSettled` survives ticks within one process. */
export function resetForTick(s: ContextStatus): void {
  s.challenges = [];
  s.tier2 = undefined;
  s.alerts = [];
  s.nextAction = undefined;
  s.lastError = undefined;
}
