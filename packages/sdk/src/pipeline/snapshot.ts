import { Contract, type Provider } from 'ethers';
import { checkEpochSynchronized, EpochNotSynchronizedError } from '../settler.js';
import { filterContextRecords } from '../membership.js';
import { DEFAULT_EIGENTRUST_PARAMS, type EigenTrustParams, type EpochInput } from '../engines/epoch/protocol.js';
import type { IAttestationProvider } from '../providers/IAttestationProvider.js';
import { loadBoundaryMembership } from './membership.js';

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
  /** First block to scan for registry logs, normally the core's deployment block. */
  fromBlock?: number;
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
  if (!synced) throw new EpochNotSynchronizedError(observedHead, boundaryTimestamp);

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
