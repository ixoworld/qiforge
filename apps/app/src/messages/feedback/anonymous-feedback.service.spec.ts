import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ENV } from 'src/types';
import { AnonymousFeedbackService } from './anonymous-feedback.service';
import type { AnonymousFeedbackIssue, FeedbackSink } from './feedback-sink';

vi.mock('@ixo/oracle-runtime', () => ({
  getModelForRole: () => 'provider/model',
}));

const context = {
  surface: 'workspace' as const,
  locale: 'en',
  theme: 'dark' as const,
  deviceClass: 'desktop' as const,
  viewportBucket: 'wide' as const,
  network: 'testnet' as const,
  portalBuildVersion: 'portal-build',
};

function createConfig(overrides: Partial<Record<keyof ENV, unknown>> = {}) {
  const values: Partial<Record<keyof ENV, unknown>> = {
    FEEDBACK_HMAC_SECRET: 'a'.repeat(32),
    ORACLE_ENTITY_DID: 'did:ixo:agent',
    ORACLE_NAME: 'Agent',
    LLM_PROVIDER: 'openrouter',
    QIFORGE_BUILD_VERSION: 'runtime-build',
    ...overrides,
  };
  return {
    get: vi.fn((key: keyof ENV, fallback?: unknown) => values[key] ?? fallback),
    getOrThrow: vi.fn((key: keyof ENV) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService<ENV>;
}

describe('AnonymousFeedbackService', () => {
  it('derives pseudonyms and sends only allowlisted safe context', async () => {
    let captured: AnonymousFeedbackIssue | undefined;
    const sink: FeedbackSink = {
      isConfigured: () => true,
      submit: vi.fn(async (issue) => {
        captured = issue;
      }),
    };
    const service = new AnonymousFeedbackService(createConfig(), sink);

    const response = await service.submit({
      did: 'did:ixo:private-user',
      clientIp: '192.0.2.10',
      sessionId: 'raw-session-id',
      messageId: 'raw-message-id',
      submissionId: '8103aeac-96e5-441b-9f87-639beca83483',
      feedback: '  The response needs sources.  ',
      context,
    });

    expect(response).toMatchObject({
      submissionId: '8103aeac-96e5-441b-9f87-639beca83483',
      status: 'submitted',
    });
    expect(captured?.feedback).toBe('The response needs sources.');
    expect(captured?.context).toEqual(context);
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain('did:ixo:private-user');
    expect(serialized).not.toContain('raw-session-id');
    expect(serialized).not.toContain('raw-message-id');
    expect(serialized).not.toContain('192.0.2.10');
    expect(captured?.userPseudonym).toMatch(/^user_[a-f0-9]{64}$/);
  });

  it('fails closed when the sink or HMAC secret is not configured', () => {
    const sink: FeedbackSink = {
      isConfigured: () => false,
      submit: vi.fn(),
    };
    expect(new AnonymousFeedbackService(createConfig(), sink).isEnabled()).toBe(
      false,
    );
    expect(
      new AnonymousFeedbackService(
        createConfig({ FEEDBACK_HMAC_SECRET: undefined }),
        { ...sink, isConfigured: () => true },
      ).isEnabled(),
    ).toBe(false);
  });

  it('rejects direct identifiers without calling the sink', async () => {
    const sink: FeedbackSink = {
      isConfigured: () => true,
      submit: vi.fn(),
    };
    const service = new AnonymousFeedbackService(createConfig(), sink);

    await expect(
      service.submit({
        did: 'did:ixo:user',
        sessionId: 'session-1',
        messageId: 'message-1',
        submissionId: '8103aeac-96e5-441b-9f87-639beca83483',
        feedback: 'Contact me at person@example.com',
        context,
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(sink.submit).not.toHaveBeenCalled();
  });

  it('limits one user and IP to three attempts per minute', async () => {
    const sink: FeedbackSink = {
      isConfigured: () => true,
      submit: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AnonymousFeedbackService(createConfig(), sink);
    const base = {
      did: 'did:ixo:user',
      clientIp: '192.0.2.10',
      sessionId: 'session-1',
      messageId: 'message-1',
      feedback: 'More detail would help.',
      context,
    };

    for (let index = 0; index < 3; index += 1) {
      await service.submit({
        ...base,
        submissionId: `8103aeac-96e5-441b-9f87-639beca8348${index}`,
      });
    }

    await expect(
      service.submit({
        ...base,
        submissionId: '8103aeac-96e5-441b-9f87-639beca83489',
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(sink.submit).toHaveBeenCalledTimes(3);
  });

  it('limits the DID and IP independently', async () => {
    const sink: FeedbackSink = {
      isConfigured: () => true,
      submit: vi.fn().mockResolvedValue(undefined),
    };
    const didLimited = new AnonymousFeedbackService(createConfig(), sink);
    const ipLimited = new AnonymousFeedbackService(createConfig(), sink);

    for (let index = 0; index < 3; index += 1) {
      await didLimited.submit({
        did: 'did:ixo:same-user',
        clientIp: `192.0.2.${index}`,
        sessionId: 'session-1',
        messageId: 'message-1',
        submissionId: `8103aeac-96e5-441b-9f87-639beca8348${index}`,
        feedback: 'More detail would help.',
        context,
      });
      await ipLimited.submit({
        did: `did:ixo:user-${index}`,
        clientIp: '192.0.2.10',
        sessionId: 'session-1',
        messageId: 'message-1',
        submissionId: `9103aeac-96e5-441b-9f87-639beca8348${index}`,
        feedback: 'More detail would help.',
        context,
      });
    }

    await expect(
      didLimited.submit({
        did: 'did:ixo:same-user',
        clientIp: '198.51.100.50',
        sessionId: 'session-1',
        messageId: 'message-1',
        submissionId: '8103aeac-96e5-441b-9f87-639beca83489',
        feedback: 'More detail would help.',
        context,
      }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      ipLimited.submit({
        did: 'did:ixo:a-different-user',
        clientIp: '192.0.2.10',
        sessionId: 'session-1',
        messageId: 'message-1',
        submissionId: '9103aeac-96e5-441b-9f87-639beca83489',
        feedback: 'More detail would help.',
        context,
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('returns a retryable service error without leaking sink details', async () => {
    const service = new AnonymousFeedbackService(createConfig(), {
      isConfigured: () => true,
      submit: vi.fn().mockRejectedValue(new Error('secret upstream detail')),
    });

    await expect(
      service.submit({
        did: 'did:ixo:user',
        sessionId: 'session-1',
        messageId: 'message-1',
        submissionId: '8103aeac-96e5-441b-9f87-639beca83483',
        feedback: 'More detail would help.',
        context,
      }),
    ).rejects.toEqual(
      expect.objectContaining<ServiceUnavailableException>({ status: 503 }),
    );
  });
});
