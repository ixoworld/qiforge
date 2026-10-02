import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createShell } from '../shell/app';
import { authenticate, type AuthOutcome } from '../shell/auth';
import { userObjectName } from '../do/contracts';

// Exercise the real Hono middleware/route with controlled authentication outcomes.
vi.mock('../shell/auth', () => ({
  authenticate: vi.fn(),
  authConfigFromEnv: vi.fn(),
  isExcluded: () => false,
  validateDelegation: vi.fn(),
}));
vi.mock('../channels/auth', () => ({
  authenticateChannel: vi.fn(),
  assertActiveChannelBinding: vi.fn(),
  channelAuthConfig: vi.fn(),
}));
vi.mock('../channels/contract', () => ({
  ChannelError: class extends Error {},
  ChannelTurnBody: {},
  channelRequestHash: vi.fn(),
  readChannelBody: vi.fn(),
}));
vi.mock('../tasks/topic-deliverables', () => ({
  TopicOperationId: {},
  TopicDeliverableRequestSchema: {},
  TOPIC_DELIVERABLE_BODY_BYTES: 1000,
}));
vi.mock('../do/transcript', () => ({ parseTranscriptPageQuery: vi.fn() }));
vi.mock('../owner-store/owner-copy-errors', () => ({
  parseOwnerCopyFailure: vi.fn(),
}));
vi.mock('../realtime/realtime-endpoint', () => ({
  ROUTED_USER_HEADER: 'x-routed-user',
}));
vi.mock('../matrix/room-state-codec', () => ({
  decodeRoomStateContent: vi.fn(),
  encodeRoomStateContent: vi.fn(),
}));
vi.mock('../do/ucan-service', () => ({ listDelegationCapabilities: vi.fn() }));
vi.mock('../shell/turn-body-cap', () => ({ turnBodyTooLarge: vi.fn() }));
vi.mock('../artifacts/routes', () => ({
  artifactDataResponse: vi.fn(),
  artifactPageResponse: vi.fn(),
}));
vi.mock('../artifacts/store', () => ({ ARTIFACT_ID_RE: /^[a-z]+$/ }));

const userDid = 'did:ixo:alice';
const origin = 'https://portal.example';
const path = '/transcription/sessions/session_123/cancel';
function harness(
  outcome: AuthOutcome = { ok: true, auth: { userDid, via: 'invocation' } },
) {
  vi.mocked(authenticate).mockResolvedValue(outcome);
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json(
      { cancelled: true },
      { headers: { 'cache-control': 'no-store' } },
    ),
  );
  const USER_ORACLE = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ fetch })),
  };
  const env = {
    ORACLE_DID: 'did:ixo:oracle',
    BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.invalid/graphql',
    TRANSCRIPTION_ENABLED: 'false',
    TRANSCRIPTION_ALLOWED_ORIGINS: origin,
    USER_ORACLE,
  };
  const request = (headers: Record<string, string> = {}, route = path) =>
    createShell().request(
      route,
      { method: 'POST', headers: { origin, ...headers }, body: '{}' },
      env,
    );
  return { request, fetch, USER_ORACLE, env };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /transcription/sessions/:sessionId/cancel', () => {
  it('uses only the proven caller and overwrites client identity headers even with admissions disabled', async () => {
    const h = harness();
    const response = await h.request({
      'x-transcription-user': 'did:ixo:bob',
      'x-identity': JSON.stringify({ userDid: 'did:ixo:bob' }),
      'x-did': 'did:ixo:bob',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(h.USER_ORACLE.idFromName).toHaveBeenCalledWith(
      userObjectName(userDid, h.env.ORACLE_DID),
    );
    expect(h.fetch).toHaveBeenCalledWith(`https://user-oracle${path}`, {
      method: 'POST',
      headers: {
        'x-transcription-user': userDid,
        'x-identity': JSON.stringify({ userDid }),
        origin,
      },
    });
  });

  it('rejects unauthenticated calls before reaching any user object', async () => {
    const h = harness({ ok: false, status: 401, error: 'unauthorized' });
    expect((await h.request()).status).toBe(401);
    expect(h.USER_ORACLE.get).not.toHaveBeenCalled();
  });

  it('rejects bare-delegation fallback for cancellation', async () => {
    const h = harness({ ok: true, auth: { userDid, via: 'delegation' } });
    const response = await h.request();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: 'invocation_required',
    });
    expect(h.USER_ORACLE.get).not.toHaveBeenCalled();
  });

  it.each(['', 'https://evil.example'])(
    'rejects missing or foreign origin %s',
    async (invalidOrigin) => {
      const h = harness();
      const response = await h.request({ origin: invalidOrigin });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'origin_forbidden' });
      expect(h.USER_ORACLE.get).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid IDs rather than constructing a different internal path', async () => {
    const h = harness();
    const response = await h.request(
      {},
      '/transcription/sessions/short/cancel',
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_session' });
    expect(h.USER_ORACLE.get).not.toHaveBeenCalled();
  });
});
