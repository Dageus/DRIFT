import type { AttestationRecord } from '../types.js';

export interface IAttestationProvider {
  /**
   * Fetches raw data from an external source (EAS, Verax, etc.)
   * and normalizes it into our standard AttestationRecord format.
   */
  fetchUserRecords(contextUID: string, userAddress: string): Promise<AttestationRecord[]>;

  /**
   * Fetches every attestation for this provider's schema — the full interaction graph, not just
   * edges into one subject. Required for genuine multi-hop reputation engines (e.g. EigenTrust's
   * indirect trust propagation): `fetchUserRecords` alone only ever yields a star graph (edges
   * into one node), which can't represent an attester's own standing being derived from other
   * attestations they received.
   */
  /**
   * With `asOf` (a ledger timestamp, normally the epoch boundary t_E returned by
   * DriftSettler.isSynchronizedForEpoch), returns the attestation set as it stood at that instant:
   * records created at or before `asOf` and not revoked by then, so every party computing Phi_c for
   * an epoch reads the same input whenever it runs. Without `asOf`, returns the currently live set.
   */
  fetchAllContextRecords(contextUID: string, asOf?: number): Promise<AttestationRecord[]>;
}
