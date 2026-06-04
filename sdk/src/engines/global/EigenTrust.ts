import { AbiCoder } from 'ethers';
import type { IReputationEngine } from '../IReputationEngine';
import type { AttestationRecord } from '../../request';

export class EigenTrustEngine implements IReputationEngine {
  private readonly coder = AbiCoder.defaultAbiCoder();

  // Schema definition tells the engine how to decode the data field
  // e.g. "uint256 score" or "uint256 grade,uint256 maxGrade"
  constructor(private readonly schemaDefinition: string) {}

  calculateScore(records: AttestationRecord[]): bigint {
    if (records.length === 0) return 0n;

    const types = this.schemaDefinition.split(',').map((f) => f.trim().split(' ')[0]);

    let total = 0n;
    let weight = 0n;

    for (const record of records) {
      try {
        const decoded = this.coder.decode(types, record.data);
        const rawScore = BigInt(decoded[0]); // first field is score
        const trustWeight = this._attesterWeight(record.attester);

        total += rawScore * trustWeight;
        weight += trustWeight;
      } catch {
        // Malformed data — skip this record
        continue;
      }
    }

    return weight === 0n ? 0n : total / weight;
  }

  // Stub — real EigenTrust reads attester reputation from The Graph
  private _attesterWeight(_attester: string): bigint {
    return 1n;
  }
}
