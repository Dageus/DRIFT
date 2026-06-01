export const GOVERNANCE_ERROR_DECODER: Record<string, { name: string; message: string }> = {
  '0x3207b711': {
    name: 'ProposalNotFound',
    message: 'The requested proposal ID does not exist or has not been initialized.'
  },
  '0xa8f192b4': {
    name: 'VotingStillActive',
    message: 'Cannot execute this proposal yet; the voting window is still open.'
  },
  '0x7c47b592': {
    name: 'VotingClosed',
    message: 'The deadline for this proposal has passed. Votes are no longer accepted.'
  },
  '0x42967272': {
    name: 'ProposalDefeated',
    message: 'The proposal failed to achieve a majority vote and cannot be executed.'
  },
  '0x1563725b': {
    name: 'ProposalAlreadyExecuted',
    message: 'This proposal payload has already been successfully triggered on-chain.'
  },
  '0xc1b9e28c': {
    name: 'AlreadyVoted',
    message: 'This wallet address has already submitted a ballot for this proposal.'
  },
  '0x9f5d166c': {
    name: 'NoVotingPower',
    message: "The sender has zero calculated voting power in this context's roles."
  },
  '0x2963bfbc': {
    name: 'ExecutionFailed',
    message: 'The target contract call reverted during proposal execution.'
  },
  '0x3aa713ee': {
    name: 'UnauthorizedRole',
    message: 'The caller does not possess the required 32-byte context administrative role.'
  },
  '0x30999554': {
    name: 'UnauthorizedSender',
    message: 'This function can only be executed directly by the governance contract itself via proposal.'
  },
  '0x4525be91': {
    name: 'SignatureAlreadyConsumed',
    message: 'Replay protection triggered: This settlement signature has already been used.'
  },
  '0x68222b4f': {
    name: 'InvalidSettlerSignature',
    message: 'The settlement signature failed cryptographic recovery against the trusted backend settler.'
  }
};

export const CORE_ERROR_DECODER: Record<string, { name: string; message: string }> = {
  '0xc72c6c03': {
    name: 'ContextTaken',
    message: 'This context name has already been claimed by another deployer.'
  },
  '0x7508e7ff': {
    name: 'ContextNotActive',
    message: 'The targeted context has been deactivated by its administrator.'
  },
  '0x02a5c92f': {
    name: 'ContextNotFound',
    message: 'The specified context UID does not exist in the registry.'
  },
  '0xa32e5f31': {
    name: 'EmptyContextName',
    message: 'Cannot register an empty string as a context domain identifier.'
  },
  '0x2213753b': {
    name: 'InvalidAdapterAddress',
    message: 'The provided schema evaluation adapter points to an invalid or zero address.'
  },
  '0xdb83ea2a': {
    name: 'InvalidSchemaUID',
    message: 'The provided schema UID string is empty or invalid.'
  },
  '0xbd048a1b': {
    name: 'SchemaNotFound',
    message: 'The requested schema UID has not been linked to this context.'
  },
  '0x6641be2d': {
    name: 'NodeNotRegistered',
    message: 'The target address is not registered or active within this context.'
  },
  '0x25cf0bb0': {
    name: 'NodeAlreadyRegistered',
    message: 'This node is already an active participant in the requested context.'
  },
  '0xb7bf4c6e': {
    name: 'TokenAlreadySet',
    message: 'The master soulbound ERC-1155 tracking token has already been linked to Core.'
  }
};
