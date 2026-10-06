import { Contract, type Provider } from 'ethers';
import { checkEpochSynchronized, EpochNotSynchronizedError } from '@drift-network/sdk';
import { filterContextRecords } from '@drift-network/sdk';
import { DEFAULT_EIGENTRUST_PARAMS, type EigenTrustParams, type EpochInput } from '@drift-network/sdk/engines';
import type { IAttestationProvider } from '@drift-network/sdk';
import { loadBoundaryMembership } from './membership.js';
import { emitTrace, type Trace } from '../recorder/recorder.js';

const CLIENT_ABI = [
  'function core() view returns (address)',
  'function contextUID() view returns (bytes32)'
];

export interface EpochSnapshotParams {
  provider: Provider;
  /** The context's governance client. */
  client: string;
  epoch: bigint;
  attestations: IAttestationProvider;
  schemaUID: string;
  /** Default: 'uint256 score'. */
  schemaDefinition?: string;
  /** Default: DEFAULT_EIGENTRUST_PARAMS. */
  params?: EigenTrustParams;
  /** Pre-trust weight for nodes without an explicit entry. Default: 1 (uniform). */
  defaultWeight?: bigint;
  pretrust?: { node: string; weight: bigint }[];
  /** Head used for the O1 check. Default 'finalized'; 'latest' only on chains that never finalize. */
  blockTag?: 'finalized' | 'safe' | 'latest';
  /**
   * First block to scan for registry logs, normally the core's deployment block (default 0). Must
   * not be after the block that registered the context: that would omit members and roles, a
   * challengeable omission. loadBoundaryMembership checks this and throws.
   */
  fromBlock?: number;
  /** Recorder hook for o1.checked and snapshot.done. Does not affect the result. */
  trace?: Trace;
}

export interface EpochSnapshot {
  input: EpochInput;
  boundaryTimestamp: bigint;
  core: string;
}

/**
 * Builds the engine input for one epoch, reading the chain as it stood at the boundary t_E:
 *
 *  1. O1: refuses (EpochNotSynchronizedError) until the provider's `blockTag` head is past t_E, so
 *     every block that can affect the input is final;
 *  2. the attestation snapshot A_c at t_E, restricted to `schemaUID`;
 *  3. membership at t_E (loadBoundaryMembership), which filters the records to attestations
 *     between members made after both joined, and gives the (node, role) pairs to settle.
 *
 * Two parties running this for the same epoch, at any time after t_E is final, get the same
 * input and so the same input digest.
 */
export async function loadEpochSnapshot(p: EpochSnapshotParams): Promise<EpochSnapshot> {
  const { synced, observedHead, boundaryTimestamp } = await checkEpochSynchronized(
    p.provider,
    p.client,
    p.epoch,
    p.blockTag ?? 'finalized'
  );
  emitTrace(p.trace, 'o1.checked', { epoch: p.epoch, synced, boundary: boundaryTimestamp, chainTime: Number(observedHead) });
  if (!synced) throw new EpochNotSynchronizedError(observedHead, boundaryTimestamp);
  const started = performance.now();

  const client = new Contract(p.client, CLIENT_ABI, p.provider);
  const [core, contextUID] = (await Promise.all([client.core!(), client.contextUID!()])) as [string, string];

  const [records, membership] = await Promise.all([
    p.attestations.fetchAllContextRecords(contextUID, Number(boundaryTimestamp)),
    loadBoundaryMembership(p.provider, core, contextUID, boundaryTimestamp, { fromBlock: p.fromBlock })
  ]);
  const schema = p.schemaUID.toLowerCase();
  const filtered = filterContextRecords(
    records.filter((r) => r.schemaUID.toLowerCase() === schema),
    membership.joinedAt
  );
  emitTrace(p.trace, 'snapshot.done', {
    epoch: p.epoch,
    records: filtered.length,
    rawRecords: records.length,
    members: membership.members.length,
    durationMs: performance.now() - started
  });

  return {
    core,
    boundaryTimestamp,
    input: {
      contextUID,
      epoch: p.epoch,
      tE: boundaryTimestamp,
      schemaUID: p.schemaUID,
      schemaDefinition: p.schemaDefinition ?? 'uint256 score',
      params: p.params ?? DEFAULT_EIGENTRUST_PARAMS,
      defaultWeight: p.defaultWeight ?? 1n,
      records: filtered,
      members: membership.members,
      pretrust: p.pretrust ?? []
    }
  };
}
