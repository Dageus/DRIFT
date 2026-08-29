import { JsonRpcProvider, Wallet, TransactionRequest } from 'ethers';
import {
  loadDeployments,
  deriveWallets,
  getPendingNonceHelper,
  sendWithSyncedNonceHelper,
  DeploymentAddresses
} from './network.config.js';

export const RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
export const provider = new JsonRpcProvider(RPC_URL);

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) throw new Error('MNEMONIC environment variable is missing');

export const { deployer, tester, alice, bob } = deriveWallets(mnemonic, provider);

const deployed = loadDeployments('11155111');

export const ADDRESSES: DeploymentAddresses = {
  DRIFTCore: process.env.DRIFT_CORE || deployed.DRIFTCore,
  DRIFTToken: process.env.DRIFT_TOKEN || deployed.DRIFTToken,
  Factory: process.env.DRIFT_FACTORY || deployed.Factory,
  WeightedGovernanceTemplate: process.env.DRIFT_TEMPLATE || deployed.WeightedGovernanceTemplate
};

export const SCHEMAS = {
  peerGrading: process.env.SCHEMA_PEER || '0x0000000000000000000000000000000000000000000000000000000000000000',
  depin: process.env.SCHEMA_DEPIN || '0x0000000000000000000000000000000000000000000000000000000000000000'
};

export function validateConfig(): void {
  const missing: string[] = [];
  if (ADDRESSES.DRIFTCore === '0x0000000000000000000000000000000000000000') missing.push('DRIFTCore');
  if (ADDRESSES.DRIFTToken === '0x0000000000000000000000000000000000000000') missing.push('DRIFTToken');
  if (ADDRESSES.Factory === '0x0000000000000000000000000000000000000000') missing.push('Factory');

  if (missing.length > 0) {
    throw new Error(`Missing config. Check deployments file.\n  - ${missing.join('\n  - ')}`);
  }
}

export const getPendingNonce = (address: string) => getPendingNonceHelper(provider, address);
export const sendWithSyncedNonce = (wallet: Wallet, tx: TransactionRequest) =>
  sendWithSyncedNonceHelper(provider, wallet, tx);
