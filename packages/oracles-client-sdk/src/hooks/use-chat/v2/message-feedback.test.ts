import { describe, expect, it, vi } from 'vitest';
import {
  isAnonymousMessageFeedbackCapabilitySupported,
  submitAnonymousMessageFeedback,
} from './message-feedback.js';

const submission = {
  submissionId: '8103aeac-96e5-441b-9f87-639beca83483',
  feedback: 'The response needs sources.',
  context: {
    surface: 'workspace' as const,
    locale: 'en',
    theme: 'dark' as const,
    deviceClass: 'desktop' as const,
    viewportBucket: 'wide' as const,
    network: 'testnet' as const,
    portalBuildVersion: 'portal-build',
  },
};

describe('submitAnonymousMessageFeedback', () => {
  it('maps one submission to POST without mutating message state', async () => {
    const authedRequest = vi.fn().mockResolvedValue({
      submissionId: submission.submissionId,
      status: 'submitted',
      submittedAt: new Date().toISOString(),
    });

    await submitAnonymousMessageFeedback({
      apiUrl: 'https://agent.example.com',
      sessionId: 'session-1',
      messageId: 'message-1',
      submission,
      oracleDid: 'did:ixo:agent',
      authedRequest,
    });

    expect(authedRequest).toHaveBeenCalledWith(
      'https://agent.example.com/messages/session-1/message-1/feedback',
      'POST',
      { body: JSON.stringify(submission) },
      'did:ixo:agent',
    );
  });
});

describe('anonymous feedback capability', () => {
  it('falls back safely when older runtimes omit the capability', () => {
    expect(isAnonymousMessageFeedbackCapabilitySupported()).toBe(false);
    expect(isAnonymousMessageFeedbackCapabilitySupported({})).toBe(false);
    expect(
      isAnonymousMessageFeedbackCapabilitySupported({
        anonymousMessageFeedback: true,
      }),
    ).toBe(true);
  });
});
