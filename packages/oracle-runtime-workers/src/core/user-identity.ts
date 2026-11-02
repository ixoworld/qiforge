import { IxoAddressSchema, type Network } from '@ixo/ixo-transaction';

/**
 * The authenticated user as the system prompt names them: the DID their
 * delegation proved, and the IXO account address it names, if any.
 */
export type UserIdentity = { did: string; address: string | null };

const IXO_DID_PREFIX = 'did:ixo:';

/**
 * The IXO account address a `did:ixo:<ixo1…>` DID names; null for any other
 * DID. An IXO account's DID is `did:ixo:` followed by its bech32 address, so
 * the address is read off the DID, never looked up. Entity DIDs
 * (`did:ixo:entity:…`), `did:key:` and `did:web:` DIDs name no account.
 */
export function ixoAddressOf(did: string): string | null {
  if (!did.startsWith(IXO_DID_PREFIX)) return null;
  const parsed = IxoAddressSchema.safeParse(did.slice(IXO_DID_PREFIX.length));
  return parsed.success ? parsed.data : null;
}

/**
 * The DID shapes the identity section prints verbatim: a lower-case method
 * and a method-specific id of up to 200 URL-safe characters. Anything else
 * (a backtick, whitespace, a line break, an over-long value) would be able to
 * break out of the inline code span and inject prompt text, so it is printed
 * as {@link UNRECOGNISED_DID} instead.
 */
const PRINTABLE_DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,200}$/;
const UNRECOGNISED_DID = 'unrecognised DID';

/** `did` as an inline code span, or the plain words "unrecognised DID". */
function printDid(did: string): string {
  return PRINTABLE_DID.test(did) ? `\`${did}\`` : UNRECOGNISED_DID;
}

/**
 * The system prompt's "Who you are talking to" section: the user's DID, their
 * IXO account address, and the oracle's own DIDs, so the model never answers
 * "what is my address?" with the oracle's. Every value is fixed for the
 * user's object, so the section is byte-identical across the user's turns
 * and stays inside the provider's prompt cache. The entity is named only
 * when it is configured and differs from `oracleDid`.
 */
export function renderUserIdentity(input: {
  user: UserIdentity;
  network: Network;
  oracleDid: string;
  oracleEntityDid?: string;
}): string {
  const { user, network, oracleDid, oracleEntityDid } = input;
  const address = user.address
    ? `- User's IXO account (wallet) address on ${network}: \`${user.address}\` — the DID's suffix. Use it for their balances, claims and transfers unless they name another; it overrides anything recalled about their address.`
    : "- User's IXO account address: none — their DID is not an IXO account; ask for one before reading balances or claims.";
  const entity =
    oracleEntityDid && oracleEntityDid !== oracleDid
      ? ` (entity ${printDid(oracleEntityDid)})`
      : '';
  return [
    '## Who you are talking to',
    '',
    `- User DID: ${printDid(user.did)}`,
    address,
    `- You are the oracle ${printDid(oracleDid)}${entity}; the domain context describes you, never the user. Never give these as the user's.`,
  ].join('\n');
}
