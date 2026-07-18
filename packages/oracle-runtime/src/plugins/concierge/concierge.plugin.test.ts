import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import type { RuntimeContext } from '../../plugin-api/types.js';
import { ConciergePlugin } from './concierge.plugin.js';
import { createOracleInfoTool } from './oracle-info-tool.js';
import { createDomainDocsTools } from './domain-docs-tools.js';
import { createEscalationTool } from './escalation-tool.js';
import { createShareArtifactTool } from './share-artifact-tool.js';
import { createRequestAuthorizationTool } from './request-authorization-tool.js';

const managerMock = {
  joinRoom: vi.fn(),
  sendMessage: vi.fn(),
  sendFileMessage: vi.fn(),
  sendMatrixEvent: vi.fn(),
  getHomeserverName: vi.fn(() => 'mx.test.ixo.earth'),
};

vi.mock('@ixo/matrix', () => ({
  MatrixManager: {
    getInstance: () => managerMock,
  },
}));

vi.mock('@ixo/oracles-chain-client', () => ({
  getSupportAccounts: vi.fn(),
  getSupportRoomAlias: vi.fn(
    (entityDid: string, hs: string) =>
      `#${entityDid.replace(/:/g, '-')}-sup:${hs}`,
  ),
  getMatrixHomeServerCroppedForDid: vi.fn(async () => 'mx.test.ixo.earth'),
}));

import { getSupportAccounts } from '@ixo/oracles-chain-client';

const getSupportAccountsMock = vi.mocked(getSupportAccounts);

function matrixCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return makeRuntimeContext({
    session: {
      id: '$thread-root',
      client: 'matrix',
      requestId: 'req-1',
      roomId: '!room:mx.test.ixo.earth',
      mode: 'concierge',
    },
    config: {
      ORACLE_DID: 'did:ixo:oracle',
      ORACLE_ENTITY_DID: 'did:ixo:entity:oracle',
      ORACLE_NAME: 'Guru',
      NETWORK: 'devnet',
    },
    ...overrides,
  });
}

beforeEach(() => {
  managerMock.joinRoom.mockReset().mockResolvedValue('!sup:mx.test.ixo.earth');
  managerMock.sendMessage.mockReset().mockResolvedValue('$sent');
  managerMock.sendFileMessage.mockReset().mockResolvedValue('$file');
  managerMock.sendMatrixEvent.mockReset().mockResolvedValue('$event');
  getSupportAccountsMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConciergePlugin', () => {
  it('has a valid always-on manifest', () => {
    const plugin = new ConciergePlugin();
    expect(plugin.name).toBe('concierge');
    expect(plugin.manifest.visibility).toBe('always');
    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('contributes no request tools outside Matrix sessions', () => {
    const plugin = new ConciergePlugin();
    const tools = plugin.getRequestTools(
      matrixCtx({
        session: {
          id: 's',
          client: 'portal',
          requestId: 'r',
        },
      }),
    );
    expect(tools).toEqual([]);
  });

  it('contributes the matrix tool set, adding domain docs only with a signing key', () => {
    const plugin = new ConciergePlugin();

    const withKey = plugin.getRequestTools(matrixCtx());
    expect(withKey.map((t) => t.name)).toEqual([
      'escalate_to_support',
      'share_artifact',
      'request_authorization',
      'search_domain_docs',
    ]);

    const noKeyCtx = matrixCtx();
    const withoutKey = plugin.getRequestTools({
      ...noKeyCtx,
      ucan: { ...noKeyCtx.ucan, hasSigningKey: () => false },
    });
    expect(withoutKey.map((t) => t.name)).toEqual([
      'escalate_to_support',
      'share_artifact',
      'request_authorization',
    ]);
  });
});

describe('get_oracle_info', () => {
  it('fetches, projects, and caches the domain card', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'did:ixo:entity:info1',
        name: 'Guru',
        summary: 'A guide.',
        faq: [{ question: 'What?', answer: 'This.' }],
        secret_internal_field: 'never',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createOracleInfoTool({
      baseUrl: 'https://indexer.test',
      entityDid: 'did:ixo:entity:info1',
    });
    const ctx = matrixCtx();

    const first = await tool.handler({}, ctx);
    expect(first).toMatchObject({
      name: 'Guru',
      summary: 'A guide.',
      faq: [{ question: 'What?', answer: 'This.' }],
    });
    expect(first).not.toHaveProperty('secret_internal_field');

    await tool.handler({}, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://indexer.test/domain-cards/did:ixo:entity:info1',
    );
  });

  it('degrades to an agent-actionable message on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    const tool = createOracleInfoTool({
      baseUrl: 'https://indexer.test',
      entityDid: 'did:ixo:entity:missing1',
    });

    const result = await tool.handler({}, matrixCtx());
    expect(result).toMatchObject({
      error: expect.stringContaining('no public domain card'),
    });
  });
});

describe('search_domain_docs', () => {
  const deps = {
    vfsBaseUrl: 'https://vfs.test',
    entityDid: 'did:ixo:entity:oracle',
    timeoutMs: 5000,
  };

  it('degrades when the oracle-signed invocation is refused', async () => {
    const [search] = createDomainDocsTools(deps);
    const ctx = matrixCtx();
    const result = await search!.handler(
      { query: 'pricing' },
      {
        ...ctx,
        ucan: {
          ...ctx.ucan,
          mintSelfSignedInvocation: async () => ({ error: 'no signing key' }),
        },
      },
    );

    expect(result).toMatchObject({
      error: expect.stringContaining('not accessible'),
    });
  });

  it('degrades when the VFS rejects the entity-namespace bearer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: 'forbidden' }),
      }),
    );
    const [search] = createDomainDocsTools(deps);

    const result = await search!.handler({ query: 'pricing' }, matrixCtx());
    expect(result).toMatchObject({
      error: expect.stringContaining('not accessible'),
    });
  });
});

describe('escalate_to_support', () => {
  const deps = { entityDid: 'did:ixo:entity:oracle', oracleName: 'Guru' };

  it('notifies support members in the Support room with mentions and a permalink', async () => {
    getSupportAccountsMock.mockResolvedValue([
      { did: 'did:ixo:ixo1human', relationship: 'support', service: 'matrix' },
    ]);
    const tool = createEscalationTool(deps);

    const result = await tool.handler(
      { summary: 'Visitor needs onboarding help', urgency: 'high' },
      matrixCtx(),
    );

    expect(managerMock.joinRoom).toHaveBeenCalledWith(
      '#did-ixo-entity-oracle-sup:mx.test.ixo.earth',
    );
    const sent = managerMock.sendMessage.mock.calls[0]?.[0] as {
      roomId: string;
      message: string;
      mentions: string[];
    };
    expect(sent.roomId).toBe('!sup:mx.test.ixo.earth');
    expect(sent.mentions).toEqual(['@did-ixo-ixo1human:mx.test.ixo.earth']);
    expect(sent.message).toContain('Visitor needs onboarding help');
    expect(sent.message).toContain('high');
    expect(sent.message).toContain('matrix.to');
    expect(result).toContain('Notified 1 support member');
  });

  it('reports honestly when no support accounts are configured', async () => {
    getSupportAccountsMock.mockResolvedValue([]);
    const tool = createEscalationTool(deps);

    const result = await tool.handler({ summary: 'help' }, matrixCtx());
    expect(result).toContain('No human support contacts are configured');
    expect(managerMock.sendMessage).not.toHaveBeenCalled();
  });

  it('fails gracefully when the Support room cannot be joined', async () => {
    getSupportAccountsMock.mockResolvedValue([
      { did: 'did:ixo:ixo1human', relationship: 'support', service: 'matrix' },
    ]);
    managerMock.joinRoom.mockRejectedValue(new Error('M_FORBIDDEN'));
    const tool = createEscalationTool(deps);

    const result = await tool.handler({ summary: 'help' }, matrixCtx());
    expect(result).toContain('could not be notified');
    expect(managerMock.sendMessage).not.toHaveBeenCalled();
  });
});

describe('share_artifact', () => {
  it('uploads md content into the current thread with the derived extension', async () => {
    const tool = createShareArtifactTool();

    const result = await tool.handler(
      { filename: 'overview', format: 'md', content: '# Overview' },
      matrixCtx(),
    );

    const call = managerMock.sendFileMessage.mock.calls[0]?.[0] as {
      roomId: string;
      filename: string;
      mimetype: string;
      threadId: string;
      data: Buffer;
    };
    expect(call.roomId).toBe('!room:mx.test.ixo.earth');
    expect(call.filename).toBe('overview.md');
    expect(call.mimetype).toBe('text/markdown');
    expect(call.threadId).toBe('$thread-root');
    expect(call.data.toString('utf-8')).toBe('# Overview');
    expect(result).toContain('Attached overview.md');
  });

  it('rejects a filename whose extension contradicts the format', async () => {
    const tool = createShareArtifactTool();

    const result = await tool.handler(
      { filename: 'report.html', format: 'md', content: 'text' },
      matrixCtx(),
    );

    expect(result).toContain('contradicts');
    expect(managerMock.sendFileMessage).not.toHaveBeenCalled();
  });
});

describe('request_authorization', () => {
  it('emits the delegation_required event into the current room', async () => {
    const tool = createRequestAuthorizationTool({
      oracleEntityDid: 'did:ixo:entity:oracle',
      oracleDid: 'did:ixo:oracle',
    });

    const result = await tool.handler({}, matrixCtx());

    expect(managerMock.sendMatrixEvent).toHaveBeenCalledWith(
      '!room:mx.test.ixo.earth',
      'ixo.oracle.delegation_required',
      { oracleEntityDid: 'did:ixo:entity:oracle', oracleDid: 'did:ixo:oracle' },
    );
    expect(result).toContain('Portal');
  });
});
