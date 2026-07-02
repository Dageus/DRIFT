import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { id } from 'ethers';
import { describe, test } from 'vitest';

describe('Merkle Tree Alignment', () => {
  test('verify structure', () => {
    const contextUID = '0x0000000000000000000000000000000000000000000000000000000000000001';
    const node1 = '0x000000000000000000000000000000000000000A';
    const node2 = '0x000000000000000000000000000000000000000B';
    const role = id('PROFESSOR_ROLE');
    const epoch = '1';

    const values = [
      [contextUID, node1, role, '100', epoch],
      [contextUID, node2, role, '200', epoch]
    ];

    const tree = StandardMerkleTree.of(values, ['bytes32', 'address', 'bytes32', 'uint256', 'uint256']);

    console.log('Root:', tree.root);
    console.log('Proof Node 1:', tree.getProof(0));
  });
});
