import type { AttestationRecord } from '../types.js';

export interface IAttestationProvider {
  /**
   * Fetches raw data from an external source (EAS, Verax, etc.)
   * and normalizes it into our standard AttestationRecord format.
   */
  fetchUserRecords(contextUID: string, userAddress: string): Promise<AttestationRecord[]>;

  /**
   * NOTE: future implementation (not enough time for the MVP)
   */
  // fetchAllContextRecords(contextUID: string): Promise<AttestationRecord[]>;
}
