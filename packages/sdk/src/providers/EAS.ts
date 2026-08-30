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

const ALL_QUERY = `
  query GetAllAttestations($schema: String!, $take: Int!, $skip: Int!) {
    attestations(
      where: { schemaId: { equals: $schema }, revoked: { equals: false } }
      orderBy: [{ time: asc }]
      take: $take
      skip: $skip
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

const PAGE_SIZE = 1000;
// Safety bound on pagination — 500 pages * PAGE_SIZE covers 500_000
const MAX_PAGES = 500;

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

  /**
   * `_contextUID` is unused for the same reason as `fetchUserRecords`: DRIFT associates a schema
   * with a context via `DRIFTCore.addAcceptedSchema` on-chain, not via a field embedded in the
   * attestation itself, and this provider is already bound to one schema at construction — so
   * filtering by schema alone already scopes the result to this context.
   */
  async fetchAllContextRecords(_contextUID: string): Promise<AttestationRecord[]> {
    const all: EasGraphQLAttestation[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(this.graphqlEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: ALL_QUERY,
          variables: { schema: this.schemaUID, take: PAGE_SIZE, skip: page * PAGE_SIZE }
        })
      });

      const json = (await res.json()) as EasGraphQLResponse;
      if (json.errors) {
        throw new DriftProviderError(`DRIFT SDK: EAS GraphQL error: ${JSON.stringify(json.errors)}`);
      }

      const batch = json.data?.attestations ?? [];
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }

    return this._normalize(all);
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
