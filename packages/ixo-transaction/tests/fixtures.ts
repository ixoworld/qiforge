import { findMessageByTypeUrl } from '../src/catalog.js';
import { parseSlashCommand } from '../src/intent.js';
import type { RiskConfirmation, TransactionDraft } from '../src/schemas.js';

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

/** A receipt-shaped value; whether it is genuine is the oracle's check. */
export const RECEIPT = {
  transactionHash: 'A'.repeat(64),
  receiptId: 'blob_0123456789abcdef',
};

/** The user accepting, word for word, every risk of the command's route. */
export function acceptAllRisks(command: string): RiskConfirmation {
  const spec = findMessageByTypeUrl(parseSlashCommand(command).typeUrl);
  if (!spec) throw new Error(`no catalog entry for ${command}`);
  return { confirmed: true, acceptedRisks: [...spec.risks] };
}

export function draft(
  command: string,
  value: Record<string, unknown>,
  extra: Partial<TransactionDraft> = {},
): TransactionDraft {
  return {
    command,
    value,
    network: 'testnet',
    riskConfirmation: acceptAllRisks(command),
    ...extra,
  };
}
