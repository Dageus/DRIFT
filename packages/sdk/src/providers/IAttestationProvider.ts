import type { AttestationRecord } from '../types';

export interface IAttestationProvider {
  /**
   * Fetches raw data from an external source (EAS, Verax, etc.)
   * and normalizes it into our standard AttestationRecord format.
   */
  fetchUserRecords(contextUID: string, userAddress: string): Promise<AttestationRecord[]>;
}
