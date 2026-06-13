export interface ITrustStore {
  /**
   * Retrieves the complete subjective trust graph for a given viewer.
   * @param viewerAddress The wallet address whose trust view is being evaluated.
   * @returns A Promise resolving to a Map of lowercase attester addresses to numerical weights.
   */
  getWeights(viewerAddress: string): Promise<Map<string, number>>;

  /**
   * Sets or updates a single subjective trust weight edge for a viewer→attester pair.
   * @param weight Scale bounds mapping (e.g., 0 = no trust, 10000 = maximum trust).
   */
  setWeight(viewerAddress: string, attesterAddress: string, weight: number): Promise<void>;

  /**
   * Removes a specific trust relationship edge from the store.
   */
  removeWeight(viewerAddress: string, attesterAddress: string): Promise<void>;

  /**
   * Clears all recorded trust configurations for a specific viewer.
   */
  clear(viewerAddress: string): Promise<void>;
}
