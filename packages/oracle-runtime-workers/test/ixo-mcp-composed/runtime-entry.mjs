import { handleIxoMcp, parseIxoMcpConfig } from '../../src/ixo-tools/mcp';
import { createMcpIxoTools } from '../../src/do/ixo-mcp';
import { readIxoToolsConfig } from '../../src/ixo-tools/config';
import { WorkersUcanService, readDelegation } from '../../src/do/ucan-service';
import {
  createDelegation,
  serializeDelegation,
  signerFromMnemonic,
} from '../../../ucan/src/index';

const userMnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const oracleMnemonic =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const config = parseIxoMcpConfig({
  resource: 'https://oracle.example/v1/mcp',
  issuer: 'https://auth.example',
  resourceClientId: 'resource-1',
  clients: [
    { clientId: 'client-1', disclosure: 'private' },
    { clientId: 'client-2', disclosure: 'private' },
    { clientId: 'client-shared' },
  ],
});
const toolsConfig = readIxoToolsConfig({
  IXO_TOOLS_SUBSCRIPTIONS_ORIGIN: 'https://subscriptions.ixo.test',
  IXO_TOOLS_MEMORY_ORIGIN: 'https://memory.ixo.test',
  IXO_TOOLS_VFS_ORIGIN: 'https://vfs.ixo.test',
  IXO_TOOLS_YELLOWCARD_ORIGIN: 'https://yellowcard.ixo.test',
  IXO_TOOLS_UCAN_STORE_ORIGIN: 'https://store.ixo.test',
  IXO_TOOLS_MODULES: 'ixo_credits_get,ixo_account_get,ixo_concept_get',
});
let fixture;
let nativeActive = true;
let scopes = [];
async function native(lifetime = 900) {
  if (fixture) return fixture;
  const { signer } = await signerFromMnemonic(userMnemonic, 'did:ixo:alice');
  const expiration = Math.floor(Date.now() / 1000) + lifetime;
  const raw = await serializeDelegation(
    await createDelegation({
      issuer: signer,
      audience: 'did:ixo:companion',
      capabilities: [
        { with: 'ixo:agent-tools', can: 'agent-tools/ixo_credits_get' },
        { with: 'ixo:agent-tools', can: 'agent-tools/ixo_account_get' },
        { with: 'ixo:agent-tools', can: 'agent-tools/ixo_concept_get' },
        { with: 'ixo:subscriptions', can: 'subscriptions/read' },
      ],
      expiration,
    }),
  );
  const grant = await readDelegation(raw);
  fixture = {
    raw,
    revision: {},
    expiration: grant.expiration,
    capabilities: grant.capabilities,
  };
  return fixture;
}
const ucan = new WorkersUcanService({
  oracleDid: 'did:ixo:companion',
  signingMnemonic: oracleMnemonic,
});
export default {
  async fetch(request, env) {
    const path = new globalThis.URL(request.url).pathname;
    if (path.startsWith('/__fixture/')) {
      if (
        env.LOCAL_STAGE7_PROOF !== 'yes' ||
        request.headers.get('x-local-proof') !== env.LOCAL_FIXTURE_SECRET
      )
        return new globalThis.Response(null, { status: 404 });
      const body = await request.json();
      if (body.action === 'nativeOff') nativeActive = false;
      if (body.action === 'nativeOn') nativeActive = true;
      if (body.action === 'shortExpiry') {
        fixture = undefined;
        await native(15);
      }
      return globalThis.Response.json({ scopes, nativeActive });
    }
    return handleIxoMcp(request, {
      config,
      secret: env.IXO_MCP_RESOURCE_CLIENT_SECRET,
      surfaceFor: async (authorization) => {
        const binding = await createMcpIxoTools({
          authorization,
          oracleDid: 'did:ixo:companion',
          network: 'devnet',
          config: toolsConfig,
          ucan,
          currentVerifiedDelegation: async () =>
            nativeActive ? native() : null,
          currentAudience: async () => authorization.client.disclosure,
        });
        scopes.push({
          client: authorization.principal.client_id,
          ...binding.scope,
        });
        return binding.tools;
      },
    });
  },
};
