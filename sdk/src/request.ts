/** Raw attestation from any provider. The data field is opaque bytes. */
export interface AttestationRecord {
  uid: string; // bytes32 hex
  schemaUID: string; // bytes32 hex
  attester: string; // address
  subject: string; // address
  timestamp: number;
  revoked: boolean;
  data: string; // hex-encoded raw bytes — decoded by engine, not provider
}

/** Decoded, engine-ready representation. Produced by the engine from raw records. */
export interface AttestationData {
  uid: string;
  subject: string;
  score: bigint; // decoded from data bytes
  timestamp: number;
}
