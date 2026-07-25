import { Client } from './client.js';
import { Entities } from './entities/entity.js';

// Create a singleton client instance

export const IXO = {
  entities: Entities,
  client: Client,
};

export * from './agent-card/index.js';
export * from './authz/index.js';
export * from './claims/index.js';
export * from './client.js';
export * from './create-wallet-from-mnemonics.js';
export * from './crypto-utils.js';
export * from './entities/index.js';
export * from './errors/matrix.js';
export * from './payments/index.js';
