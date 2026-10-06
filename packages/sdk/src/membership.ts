import type { AttestationRecord } from './types.js';

/**
 * Join time of every party that counts as a member, keyed by lowercase address. A party absent
 * from the map is not a member. Two sources build it: the current registry state (local mode) and
 * the registry state at an epoch boundary (settlement, packages/operator/src/pipeline/membership.ts).
 */
export type JoinTimes = Map<string, bigint>;

/**
 * Mirrors DRIFTCore.verifyAttestation off-chain, per record: both parties must be members, and the
 * record must not predate either party's registration. Without the membership check a
 * never-registered address or a deregistered node would pass the join-time test, letting outsiders
 * shape a context's reputation.
 */
export function filterContextRecords(records: AttestationRecord[], joinedAt: JoinTimes): AttestationRecord[] {
  return records.filter((r) => {
    const subjectJoined = joinedAt.get(r.subject.toLowerCase());
    const attesterJoined = joinedAt.get(r.attester.toLowerCase());
    if (subjectJoined === undefined || attesterJoined === undefined) return false;
    const ts = BigInt(r.timestamp);
    return ts >= subjectJoined && ts >= attesterJoined;
  });
}

/** Every distinct party (attester or subject) of `records`, lowercased. */
export function recordParties(records: AttestationRecord[]): string[] {
  return [...new Set(records.flatMap((r) => [r.subject.toLowerCase(), r.attester.toLowerCase()]))];
}
