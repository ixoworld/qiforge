import type { OracleConfig } from '@ixo/oracle-runtime-workers';

/**
 * Oracle identity + prompt. `entityDid` comes from the `ORACLE_ENTITY_DID`
 * binding; everything else is authored here.
 */
export const config: OracleConfig = {
  name: 'QiForge Workers Example',
  org: 'IXO',
  description:
    'A reference oracle running on Cloudflare Workers — weather lookups and skill discovery.',
  prompt: {
    communicationStyle: [
      '- Be concise. Answer the question first, then add context only if useful.',
      '- Use Unicode emoji directly (🔥), never text shortcodes (:fire:).',
      '- When a tool provides a fact (temperature, forecast), quote the number exactly.',
    ].join('\n'),
  },
};
