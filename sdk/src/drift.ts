import { Signer, Provider } from 'ethers';
import { DriftClient, DriftConfig } from './client';
import { DriftSettler } from './settler';
import { DriftFactory } from './factory';

/**
 * Unified DRIFT SDK entry point.
 *
 * Usage:
 *   const drift = new Drift(signer, config);
 *   await drift.client.registerContext("university.harvard");
 *   await drift.client.registerNode(contextUID);
 *   const { score, signature } = await drift.settler.generateSettlementSignature(...);
 */
export class Drift {
  public readonly client: DriftClient;
  public readonly factory: DriftFactory;
  public readonly settler?: DriftSettler;

  constructor(signerOrProvider: Signer | Provider, config: DriftConfig) {
    this.client = new DriftClient(config, signerOrProvider);
    this.factory = new DriftFactory(config.factoryAddress, signerOrProvider);

    // Settler only available if a signer was provided
    if (signerOrProvider instanceof Signer || 'signMessage' in signerOrProvider) {
      this.settler = new DriftSettler(signerOrProvider as Signer);
    }
  }
}
