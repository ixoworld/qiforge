import { z } from 'zod';
import {
  ImportError,
  sha256,
  type ImportBody,
  type StatusBody,
} from './contract';
import {
  boundedBytes,
  boundedJson,
  noRedirectFetch,
  publicUrl,
} from './network';

const Entity = z.object({
  id: z.string(),
  type: z.string(),
  owner: z.string().nullable(),
  controller: z.array(z.string()),
  linkedEntity: z.array(z.object({ id: z.string(), type: z.string() })),
  linkedResource: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      serviceEndpoint: z.string(),
      proof: z.string().optional(),
    }),
  ),
  service: z.array(
    z.object({ id: z.string(), type: z.string(), serviceEndpoint: z.string() }),
  ),
});
const EntityResponse = z.object({
  data: z.object({ entity: Entity.nullable() }),
  errors: z.array(z.unknown()).optional(),
});
export interface DestinationConfig {
  oracleDid: string;
  oracleEntityDid: string;
  network: string;
  blocksyncUrl: string;
}
/** The request addresses this deployment's oracle account, entity and network. */
export function assertDeployment(
  body: ImportBody | StatusBody,
  config: DestinationConfig,
): void {
  if (
    body.oracleDid !== config.oracleDid ||
    body.oracleEntityDid !== config.oracleEntityDid ||
    body.network !== config.network
  )
    throw new ImportError(403, 'deployment_mismatch');
}

export async function verifyDestination(
  body: ImportBody,
  config: DestinationConfig,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  assertDeployment(body, config);
  publicUrl(config.blocksyncUrl);
  // `missing` is the refusal for an entity that does not exist on chain: a
  // definite answer, unlike a lookup that failed.
  const load = async (id: string, missing: string) => {
    const response = await noRedirectFetch(fetcher, config.blocksyncUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query:
          'query MemoryImportEntity($id: String!) { entity(id: $id) { id type owner controller linkedEntity linkedResource service } }',
        variables: { id },
      }),
    });
    if (!response.ok) throw new ImportError(503, 'entity_lookup_failed');
    const parsed = EntityResponse.safeParse(await boundedJson(response));
    if (!parsed.success || parsed.data.errors?.length)
      throw new ImportError(503, 'invalid_entity_response');
    const entity = parsed.data.data.entity;
    if (!entity) throw new ImportError(403, missing);
    if (entity.id !== id) throw new ImportError(503, 'invalid_entity_response');
    return entity;
  };
  const domain = await load(body.domainDid, 'exact_domain_control_required');
  const callerForms = [body.userDid, body.userDid.slice('did:ixo:'.length)];
  if (
    !callerForms.includes(domain.owner ?? '') &&
    !domain.controller.some((controller) => callerForms.includes(controller))
  )
    throw new ImportError(403, 'exact_domain_control_required');
  // As the Portal offers destinations: the domain's `oracle/oracle` links,
  // or the domain itself when it is an oracle.
  const isOracle =
    domain.type === 'oracle' || domain.type.startsWith('oracle/');
  if (
    !(isOracle && domain.id === body.oracleEntityDid) &&
    !domain.linkedEntity.some(
      (link) =>
        link.id === body.oracleEntityDid && link.type === 'oracle/oracle',
    )
  )
    throw new ImportError(403, 'oracle_not_associated');
  const oracle =
    domain.id === body.oracleEntityDid
      ? domain
      : await load(body.oracleEntityDid, 'not_an_oracle');
  if (!(oracle.type === 'oracle' || oracle.type.startsWith('oracle/')))
    throw new ImportError(403, 'not_an_oracle');
  const resources = oracle.linkedResource.filter(
    (resource) =>
      [`${oracle.id}#orz`, '{id}#orz', '#orz'].includes(resource.id) &&
      resource.type === 'oracleAuthZConfig',
  );
  const resource = resources[0];
  if (
    resources.length !== 1 ||
    !resource ||
    !resource.proof ||
    !/^[a-fA-F0-9]{64}$/.test(resource.proof)
  )
    throw new ImportError(403, 'oracle_config_proof_required');
  const url = publicUrl(resource.serviceEndpoint);
  const response = await noRedirectFetch(fetcher, url);
  if (!response.ok) throw new ImportError(503, 'oracle_config_unavailable');
  const bytes = await boundedBytes(response);
  if ((await sha256(bytes)) !== resource.proof.toLowerCase())
    throw new ImportError(403, 'oracle_config_hash_mismatch');
  let document: unknown;
  try {
    // A leading BOM is dropped, as the Portal reads the same document.
    document = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    // The published bytes match their proof, so this is permanent.
    throw new ImportError(403, 'oracle_account_mismatch');
  }
  const configDoc = z
    .object({ granteeAddress: z.string().regex(/^ixo1[a-z0-9]+$/) })
    .safeParse(document);
  if (
    !configDoc.success ||
    `did:ixo:${configDoc.data.granteeAddress}` !== config.oracleDid
  )
    throw new ImportError(403, 'oracle_account_mismatch');
  const services = oracle.service.filter(
    (service) => service.type === 'oracleService',
  );
  if (services.length !== 1 || !services[0])
    throw new ImportError(403, 'oracle_service_ambiguous');
  publicUrl(services[0].serviceEndpoint, true);
}
