import type { PodProfile } from './chain-gateway';

/**
 * A POD's domain card, as the Portal composes a fresh one for a domain it
 * creates (ixo-portal `lib/entity/domainCard.ts`, `freshDomainCardDocument`):
 * a W3C VerifiableCredential of type `ixo:DomainCard` issued by the owner,
 * whose subject is the entity. The domain indexer reads it from the entity's
 * `{id}#dmn` linked resource to list and search the domain. No logo, image,
 * tags or purpose: the POD creator collects only the name and description.
 */
export function podDomainCardDocument(input: {
  podDid: string;
  ownerDid: string;
  profile: PodProfile;
  validFrom: string;
}): Record<string, unknown> {
  const { podDid, ownerDid, profile, validFrom } = input;
  return {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://w3id.org/ixo/context/v1',
      {
        attribute: 'https://w3id.org/ixo/attributes/v1/',
        schema: 'https://schema.org/',
        ixo: 'https://w3id.org/ixo/vocab/v1',
        prov: 'http://www.w3.org/ns/prov#',
        proj: 'https://linked.data.gov.au/def/project#',
        xsd: 'http://www.w3.org/2001/XMLSchema#',
        id: '@id',
        type: '@type',
        'ixo:vector': { '@container': '@list', '@type': 'xsd:double' },
        '@protected': true,
      },
    ],
    id: `${podDid}#dmn`,
    type: ['VerifiableCredential', 'ixo:DomainCard'],
    issuer: { id: ownerDid },
    validFrom,
    credentialSchema: {
      id: 'https://w3id.org/ixo/schemas/ixo-domain-card-1.json',
      type: 'JsonSchema',
    },
    credentialSubject: {
      id: podDid,
      type: ['ixo:Domain'],
      additionalType: ['schema:Organization'],
      name: profile.name,
      description: profile.description ?? '',
      sameAs: [],
      logo: { type: 'schema:ImageObject', id: '', contentUrl: '' },
      image: [{ type: 'schema:ImageObject', id: '', contentUrl: '' }],
      keywords: [],
      knowsAbout: [],
      composition: { type: 'schema:Collection', hasPart: [] },
      makesOffer: [],
      relationships: {
        'prov:wasAssociatedWith': [],
        memberOf: [],
        funding: [],
      },
      agents: [],
      credentials: [],
      attributes: [],
      project: {},
    },
  };
}
