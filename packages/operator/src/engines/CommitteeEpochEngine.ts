import { DriftConfigError, DriftEngineError } from '@drift-network/sdk';
import type { IEpochEngine } from '@drift-network/sdk/engines';
import type { EpochInput, EpochResult } from '@drift-network/sdk/engines';

export interface CommitteeEpochEngineConfig {
  /** One engine per committee member, each returning 'signed' evidence (e.g. GrpcEpochEngine). */
  members: IEpochEngine[];
  /** Addresses of the committee. Signatures from anyone else do not count. */
  signers: string[];
  /** Matching signatures required, t of n. */
  threshold: number;
}

/**
 * Tier 2 without SMPC: n independent engines recompute Phi_c on the same public input and sign
 * the journal; the result stands when t distinct committee signers agree on identical journal
 * bytes. Attestations are public, so there is no input to hide, and agreement on a deterministic
 * function is all a threshold needs. The signatures are what a threshold-checking contract (or an
 * ERC-1271 committee wallet) would verify; this class only collects them.
 */
export class CommitteeEpochEngine implements IEpochEngine {
  private readonly signers: Set<string>;

  constructor(private readonly config: CommitteeEpochEngineConfig) {
    this.signers = new Set(config.signers.map((s) => s.toLowerCase()));
    if (config.threshold < 1 || config.threshold > this.signers.size) {
      throw new DriftConfigError(`DRIFT SDK: committee threshold ${config.threshold} is outside 1..${this.signers.size}.`);
    }
  }

  async computeEpoch(input: EpochInput): Promise<EpochResult> {
    const settled = await Promise.allSettled(this.config.members.map((m) => m.computeEpoch(input)));

    // Group signatures by the exact journal bytes they cover.
    const groups = new Map<string, { result: EpochResult; bySigner: Map<string, string> }>();
    const failures: string[] = [];
    for (const s of settled) {
      if (s.status === 'rejected') {
        failures.push(s.reason instanceof Error ? s.reason.message : String(s.reason));
        continue;
      }
      const r = s.value;
      if (r.evidence.kind !== 'signed') {
        failures.push(`member returned '${r.evidence.kind}' evidence`);
        continue;
      }
      const g = groups.get(r.journalBytes) ?? { result: r, bySigner: new Map() };
      for (const { signer, signature } of r.evidence.signatures) {
        if (this.signers.has(signer.toLowerCase())) g.bySigner.set(signer.toLowerCase(), signature);
      }
      groups.set(r.journalBytes, g);
    }

    for (const { result, bySigner } of groups.values()) {
      if (bySigner.size >= this.config.threshold) {
        const signatures = [...bySigner].sort(([a], [b]) => (a < b ? -1 : 1)).map(([signer, signature]) => ({ signer, signature }));
        return { ...result, evidence: { kind: 'signed', signatures } };
      }
    }
    const best = Math.max(0, ...[...groups.values()].map((g) => g.bySigner.size));
    throw new DriftEngineError(
      `DRIFT SDK: committee reached ${best} of ${this.config.threshold} matching signatures` +
        (failures.length ? `; failures: ${failures.join('; ')}` : '') +
        '.'
    );
  }
}
