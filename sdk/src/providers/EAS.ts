import type { IAttestationProvider } from './IAttestationProvider';
import type { AttestationRecord } from '../request';

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

const FILTERED_QUERY = `
  query GetFilteredAttestations($attester: String!, $recipient: String!, $schema: String!) {
    attestations(
      where: {
        attester:  { equals: $attester }
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

    const json = await res.json();
    if (json.errors) {
      throw new Error(`EAS GraphQL error: ${JSON.stringify(json.errors)}`);
    }
    return this._normalize(data.attestations);
  }

  private _normalize(attestations: any[]): AttestationRecord[] {
    if (!attestations) return [];
    return attestations.map(
      (a: any): AttestationRecord => ({
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
