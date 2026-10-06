import { describe, it, expect, afterEach, vi } from 'vitest';
import { EASProvider } from '../../src/providers/EAS.js';

const SCHEMA = '0x' + '11'.repeat(32);
const T_E = 1_000; // epoch boundary under test

const row = (id: string, timeCreated: number, revocationTime = 0) => ({
  id,
  schemaId: SCHEMA,
  attester: '0x' + 'aa'.repeat(20),
  recipient: '0x' + 'bb'.repeat(20),
  timeCreated,
  revocationTime,
  data: '0x'
});

/** Serves one page of `rows` and records every request body. */
function mockEndpoint(rows: ReturnType<typeof row>[]) {
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { json: async () => ({ data: { attestations: rows } }) };
    })
  );
  return bodies;
}

describe('EASProvider boundary snapshot', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the attestation set as it stood at asOf', async () => {
    const bodies = mockEndpoint([
      row('live', 900),
      row('revokedBefore', 900, 950),
      row('revokedAtBoundary', 900, T_E),
      row('revokedAfter', 900, 1_100),
      row('createdAtBoundary', T_E),
      row('createdAfter', 1_001) // the query filters these out; the client must not trust that alone
    ]);

    const records = await new EASProvider('http://eas', SCHEMA).fetchAllContextRecords('0xctx', T_E);

    expect(records.map((r) => r.uid)).toEqual(['live', 'revokedAfter', 'createdAtBoundary']);
    expect(records.every((r) => !r.revoked)).toBe(true);
    // Revoked attestations must be fetched (one revoked after t_E was live at t_E), bounded by t_E.
    expect(bodies[0]!.query).toContain('timeCreated: { lte: $asOf }');
    expect(bodies[0]!.query).not.toContain('revoked');
    expect(bodies[0]!.variables.asOf).toBe(T_E);
  });

  it('keeps the live-set query when no asOf is given', async () => {
    const bodies = mockEndpoint([row('live', 900), row('revoked', 900, 950)]);

    const records = await new EASProvider('http://eas', SCHEMA).fetchAllContextRecords('0xctx');

    expect(bodies[0]!.query).toContain('revoked: { equals: false }');
    expect(records.find((r) => r.uid === 'revoked')!.revoked).toBe(true);
  });

  it('pages in small, totally ordered pages', async () => {
    // The public indexer drops a response above roughly 140 kB, so one page must stay small; skip
    // pagination over attestations sharing a block time needs the id tie-break.
    const all = Array.from({ length: 250 }, (_, i) => row(`a${i}`, 900));
    const bodies: { query: string; variables: { take: number; skip: number } }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as (typeof bodies)[number];
        bodies.push(body);
        return { json: async () => ({ data: { attestations: all.slice(body.variables.skip, body.variables.skip + body.variables.take) } }) };
      })
    );

    const records = await new EASProvider('http://eas', SCHEMA).fetchAllContextRecords('0xctx', T_E);

    expect(records.map((r) => r.uid)).toEqual(all.map((r) => r.id));
    expect(bodies.map((b) => b.variables.skip)).toEqual([0, 100, 200]);
    expect(bodies.every((b) => b.variables.take === 100)).toBe(true);
    expect(bodies[0]!.query).toContain('orderBy: [{ time: asc }, { id: asc }]');
  });
});
