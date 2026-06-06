export interface ITrustStore {
  getWeights(viewerAddress: string): Promise<Map<string, number>> | Map<string, number>;
}
