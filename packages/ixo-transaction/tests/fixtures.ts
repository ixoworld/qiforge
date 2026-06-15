import type { TransactionDraft } from '../src/schemas.js';

export const ADDRESS = 'ixo1qwertyuiopasdfghjklzxcvbnmqwerty12345';
export const ADDRESS_2 = 'ixo1zxcvbnmqwertyuiopasdfghjkl1234567890ab';
export const DID = `did:ixo:${ADDRESS}`;
export const DID_2 = `did:ixo:${ADDRESS_2}`;
export const ENTITY_DID = 'did:ixo:entity:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export const verification = [
  {
    relationships: ['authentication'],
    method: {
      id: `${DID}#key-1`,
      type: 'EcdsaSecp256k1VerificationKey2019',
      controller: DID,
      blockchainAccountID: ADDRESS,
    },
  },
];

export const riskConfirmation = {
  confirmed: true as const,
  acceptedRisks: ['User confirmed transaction risks before rendering.'],
};

export function draft(
  command: string,
  value: Record<string, unknown>,
  extra: Partial<TransactionDraft> = {},
): TransactionDraft {
  return {
    command,
    value,
    network: 'testnet',
    riskConfirmation,
    ...extra,
  };
}
