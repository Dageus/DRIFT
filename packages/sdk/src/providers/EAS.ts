import type { IAttestationProvider } from './IAttestationProvider.js';
import type { AttestationRecord } from '../types.js';
import { DriftProviderError } from '../errors.js';

const USER_QUERY = `
  query GetAttestations($recipient: String!, $schema: String!) {
    attestations(
      where: {
        recipient: { equals: $recipient }
        schemaId:  { equals: $schema }
        revoked:   { equals: false }
      }
    ) {
      id
      schemaId
      attester
      recipient
      timeCreated
      revocationTime
      data
    }
  }
`;

interface EasGraphQLAttestation {
  id: string;
  schemaId: string;
  attester: string;
  recipient: string;
  timeCreated: number | string;
  revocationTime: number | string;
  data: string;
}

interface EasGraphQLResponse {
  errors?: unknown;
  data?: { attestations?: EasGraphQLAttestation[] };
}

export class EASProvider implements IAttestationProvider {
  constructor(
    private readonly graphqlEndpoint: string,
    private readonly schemaUID: string
  ) {}

  async fetchUserRecords(_contextUID: string, userAddress: string): Promise<AttestationRecord[]> {
    const res = await fetch(this.graphqlEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: USER_QUERY,
        variables: { recipient: userAddress, schema: this.schemaUID }
      })
    });

    const json = (await res.json()) as EasGraphQLResponse;
    if (json.errors) {
      throw new DriftProviderError(`DRIFT SDK: EAS GraphQL error: ${JSON.stringify(json.errors)}`);
    }
    return this._normalize(json.data?.attestations);
  }

  private _normalize(attestations?: EasGraphQLAttestation[]): AttestationRecord[] {
    if (!attestations) return [];
    return attestations.map(
      (a): AttestationRecord => ({
        uid: a.id,
        schemaUID: a.schemaId,
        attester: a.attester,
        subject: a.recipient,
        timestamp: Number(a.timeCreated),
        revoked: Number(a.revocationTime) > 0,
        data: a.data
      })
    );
  }
}
