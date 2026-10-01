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

/** What /status reports for one context. Rebuilt from chain state on every tick, never persisted. */
export interface ContextStatus {
  name: string;
  client: string;
  roles: Role[];
  contextUID?: string;
  currentEpoch?: string;
  lastSettled?: { epoch: string; root: string; treeURI: string; txHash: string };
  challenges: ChallengeStatus[];
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
  s.alerts = [];
  s.nextAction = undefined;
  s.lastError = undefined;
}
