import { describe, it, expect } from 'vitest';
import { Wallet, type Provider } from 'ethers';
import { Drift } from '../../src/drift.js';
import type { IAttestationProvider } from '../../src/providers/IAttestationProvider.js';
import type { ITrustStore } from '../../src/trust/ITrustStore.js';
import type { AttestationRecord } from '../../src/types.js';

const CONTEXT = '0x' + '22'.repeat(32);
const member = Wallet.createRandom().address.toLowerCase();
const otherMember = Wallet.createRandom().address.toLowerCase();
const outsider = Wallet.createRandom().address.toLowerCase(); // never registered: joined-at reads 0
const leaver = Wallet.createRandom().address.toLowerCase(); // deregistered: joined-at is kept

// Mirrors DRIFTCore: status cleared on deregistration, registration timestamp kept.
const registered = new Map([
  [member, true],
  [otherMember, true],
  [outsider, false],
  [leaver, false]
]);
const joinedAt = new Map([
  [member, 100n],
  [otherMember, 100n],
  [outsider, 0n],
  [leaver, 100n]
]);

const rec = (uid: string, attester: string, subject: string, timestamp: number): AttestationRecord => ({
  uid,
  schemaUID: '0x' + '11'.repeat(32),
  attester,
  subject,
  timestamp,
  revoked: false,
  data: '0x'
});

type Filter = { _dropPreJoinAttestations(c: string, r: AttestationRecord[]): Promise<AttestationRecord[]> };

function makeDrift(): Drift {
  const drift = new Drift({} as unknown as Provider, {
    coreAddress: Wallet.createRandom().address,
    factoryAddress: Wallet.createRandom().address,
    attestationProvider: {} as IAttestationProvider,
    storageProvider: {} as ITrustStore
  });
  Object.assign(drift.core, {
    isRegistered: async (_c: string, n: string) => registered.get(n.toLowerCase()) ?? false,
    getNodeRegisteredAt: async (_c: string, n: string) => joinedAt.get(n.toLowerCase()) ?? 0n
  });
  return drift;
}

describe('Drift local-mode membership filter', () => {
  it('keeps only attestations between current members, made after both joined', async () => {
    const kept = await (makeDrift() as unknown as Filter)._dropPreJoinAttestations(CONTEXT, [
      rec('members', member, otherMember, 200),
      rec('beforeJoin', member, otherMember, 50),
      rec('fromOutsider', outsider, member, 200), // passed the old join-time-only check (200 >= 0)
      rec('aboutOutsider', member, outsider, 200),
      rec('fromLeaver', leaver, member, 200) // passed the old check (200 >= 100)
    ]);
    expect(kept.map((r) => r.uid)).toEqual(['members']);
  });
});
