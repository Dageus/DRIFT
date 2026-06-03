import { AbiCoder } from 'ethers';
import type { AttestationRecord, AttestationData } from './request';

export class SchemaEncoder {
  private readonly coder = AbiCoder.defaultAbiCoder();

  /**
   * Decodes the raw bytes from an AttestationRecord into typed AttestationData.
   * Schema definition mirrors EAS format: "uint256 score,uint256 timestamp"
   */
  decode(record: AttestationRecord, schemaDefinition: string): AttestationData {
    const types  = schemaDefinition.split(',').map(f => f.trim().split(' ')[0]);
    const values = this.coder.decode(types, record.data);

    return {
      uid:       record.uid,
      subject:   record.subject,
      score:     BigInt(values[0]),   // assumes first field is score
      timestamp: record.timestamp
    };
  }

  encode(schemaDefinition: string, values: unknown[]): string {
    const types = schemaDefinition.split(',').map(f => f.trim().split(' ')[0]);
    return this.coder.encode(types, values);
  }
}
