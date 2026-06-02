import { Signer, Contract, Interface, Provider, id } from 'ethers';
import { roleId } from './utils';

const FACTORY_ABI = [
  'function deployClient(bytes32 contextUID, address implementation, bytes calldata initData, bytes32 salt) external returns (address clone)',
  'event ClientDeployed(address indexed client, bytes32 indexed contextUID, address implementation)'
];

const WEIGHTED_GOVERNANCE_INIT_ABI = [
  'function initialize(address _core, address _token, bytes32 _contextUID, address _trustedSettler, bytes32[] calldata _roles, uint256[] calldata _weights)'
];

export class DriftFactory {
  private readonly contract: Contract;
  private readonly iface: Interface;

  constructor(factoryAddress: string, signerOrProvider: Signer | Provider) {
    this.iface    = new Interface(FACTORY_ABI);
    this.contract = new Contract(factoryAddress, FACTORY_ABI, signerOrProvider);
  }

  public async deployClient(
    contextUID:     string,
    implementation: string,
    initData:       string,
    salt:           string
  ): Promise<string> {
    const tx      = await this.contract.deployClient(contextUID, implementation, initData, salt);
    const receipt = await tx.wait();
    return this._extractClientAddress(receipt);
  }

  public async deployWeightedGovernance(params: {
    contextUID:     string;
    implementation: string;
    coreAddress:    string;
    tokenAddress:   string;
    trustedSettler: string;
    roles:          string[];
    weights:        bigint[];
    salt:           string;
  }): Promise<string> {
    const encodedRoles = params.roles.map(r => roleId(r));

    const initData = new Interface(WEIGHTED_GOVERNANCE_INIT_ABI).encodeFunctionData(
      'initialize',
      [
        params.coreAddress,
        params.tokenAddress,
        params.contextUID,
        params.trustedSettler,
        encodedRoles,
        params.weights
      ]
    );

    return this.deployClient(
      params.contextUID,
      params.implementation,
      initData,
      id(params.salt)
    );
  }

  private _extractClientAddress(receipt: any): string {
    const log = receipt.logs
      .map((l: any) => { try { return this.iface.parseLog(l); } catch { return null; } })
      .find((l: any) => l?.name === 'ClientDeployed');

    if (!log) throw new Error('DriftFactory: ClientDeployed event not found in receipt.');
    return log.args.client;
  }
}
