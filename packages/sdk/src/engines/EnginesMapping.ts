import { EigenTrustEngine } from './EigenTrust';
import { IReputationEngine } from './IReputationEngine';

export interface EngineCreationParams {
  schemaDefinition: string;
  weightResolver?: (attester: string) => bigint;
}

export const REPUTATION_ENGINES: Record<string, (params: EngineCreationParams) => IReputationEngine> = {
  EigenTrust: (params) =>
    new EigenTrustEngine({
      schemaDefinition: params.schemaDefinition,
      weightResolver: params.weightResolver
    }),
  UniformAverage: (params) =>
    new EigenTrustEngine({
      schemaDefinition: params.schemaDefinition,
      weightResolver: () => 1n // Hardcoded default preset fallback
    })
};
