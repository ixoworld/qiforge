import { describe, expect, it, vi } from 'vitest';
import { RequestError } from '../../../utils/request.js';
import { fetchHistoryPage } from '../../../utils/transcript-pages.js';
import {
  isAnonymousMessageFeedbackCapabilitySupported,
  submitAnonymousMessageFeedback,
} from './message-feedback.js';
import type { AnonymousMessageFeedbackSubmission, IMessage } from './types.js';

const submission: AnonymousMessageFeedbackSubmission = {
  submissionId: '8103aeac-96e5-441b-9f87-639beca83483',
  feedback: 'The response needs sources.',
  context: {
    surface: 'workspace',
    locale: 'en',
    theme: 'dark',
    deviceClass: 'desktop',
    viewportBucket: 'wide',
    network: 'testnet',
    portalBuildVersion: 'portal-build',
  },
};

describe('submitAnonymousMessageFeedback', () => {
  it('POSTs exactly the submission to the message feedback route, as the oracle client', async () => {
    const authedRequest = vi.fn().mockResolvedValue({
      submissionId: submission.submissionId,
      status: 'submitted',
      submittedAt: '2026-10-05T09:00:00.000Z',
    });

    // A caller passing more than the contract must not leak it.
    const withExtra = { ...submission, prompt: 'secret prompt' };
    const response = await submitAnonymousMessageFeedback({
      apiUrl: 'https://agent.example.com',
      sessionId: '$thread:ixo.world',
      messageId: 'message-1',
      submission: withExtra,
      oracleDid: 'did:ixo:agent',
      authedRequest,
    });

    expect(authedRequest).toHaveBeenCalledTimes(1);
    expect(authedRequest).toHaveBeenCalledWith(
      'https://agent.example.com/messages/%24thread%3Aixo.world/message-1/feedback',
      'POST',
      { body: JSON.stringify(submission) },
      'did:ixo:agent',
    );
    expect(response.status).toBe('submitted');
  });

  it('surfaces the runtime’s refusal unchanged, code and retry hint included', async () => {
    const refusal = new RequestError('Remove personal information', {
      status: 422,
      code: 'FEEDBACK_CONTAINS_PERSONAL_DATA',
      retryable: false,
    });
    await expect(
      submitAnonymousMessageFeedback({
        apiUrl: 'https://agent.example.com',
        sessionId: 's',
        messageId: 'm',
        submission,
        oracleDid: 'did:ixo:agent',
        authedRequest: vi.fn().mockRejectedValue(refusal),
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'FEEDBACK_CONTAINS_PERSONAL_DATA',
      retryable: false,
    });
  });
});

describe('anonymous feedback capability', () => {
  it('is off unless the runtime advertises it', () => {
    expect(isAnonymousMessageFeedbackCapabilitySupported()).toBe(false);
    expect(isAnonymousMessageFeedbackCapabilitySupported({})).toBe(false);
    expect(
      isAnonymousMessageFeedbackCapabilitySupported({
        anonymousMessageFeedback: true,
      }),
    ).toBe(true);
  });

  it('is read from the paged transcript and from the legacy listing', async () => {
    const paged = await fetchHistoryPage<IMessage>(
      (async () => ({
        messages: [],
        prevCursor: null,
        nextCursor: null,
        hasOlder: false,
        hasNewer: false,
        capabilities: { anonymousMessageFeedback: true },
      })) as never,
      'https://o',
      's',
      { limit: 20 },
    );
    expect(
      isAnonymousMessageFeedbackCapabilitySupported(paged.capabilities),
    ).toBe(true);

    const legacy = await fetchHistoryPage<IMessage>(
      (async (url: string) => {
        if (url.includes('/sessions/'))
          throw new RequestError('Cannot GET', { status: 404 });
        return {
          messages: [],
          capabilities: { anonymousMessageFeedback: true },
        };
      }) as never,
      'https://o',
      's',
      { limit: 20 },
    );
    expect(
      isAnonymousMessageFeedbackCapabilitySupported(legacy.capabilities),
    ).toBe(true);

    const older = await fetchHistoryPage<IMessage>(
      (async () => ({
        messages: [],
        prevCursor: null,
        nextCursor: null,
        hasOlder: false,
        hasNewer: false,
      })) as never,
      'https://o',
      's',
      { limit: 20 },
    );
    expect(
      isAnonymousMessageFeedbackCapabilitySupported(older.capabilities),
    ).toBe(false);
  });
});
