import { describe, expect, it, vi } from 'vitest';
import {
  applyMessageFeedbackOptimistically,
  isMessageFeedbackCapabilitySupported,
  persistMessageFeedback,
} from './message-feedback.js';
import type { IMessage } from './types.js';

describe('persistMessageFeedback', () => {
  const base = {
    apiUrl: 'https://agent.example.com',
    sessionId: 'session-1',
    messageId: 'message-1',
    oracleDid: 'did:ixo:agent',
  };

  it('uses PUT to save feedback', async () => {
    const authedRequest = vi.fn().mockResolvedValue({ feedback: 'approved' });

    await persistMessageFeedback({
      ...base,
      feedback: 'approved',
      authedRequest,
    });

    expect(authedRequest).toHaveBeenCalledWith(
      'https://agent.example.com/messages/session-1/message-1/feedback',
      'PUT',
      { body: JSON.stringify({ feedback: 'approved' }) },
      'did:ixo:agent',
    );
  });

  it('uses DELETE to clear feedback', async () => {
    const authedRequest = vi.fn().mockResolvedValue({ feedback: null });

    await persistMessageFeedback({
      ...base,
      feedback: null,
      authedRequest,
    });

    expect(authedRequest).toHaveBeenCalledWith(
      'https://agent.example.com/messages/session-1/message-1/feedback',
      'DELETE',
      {},
      'did:ixo:agent',
    );
  });
});

describe('message feedback state', () => {
  it('falls back safely when older runtimes omit the capability', () => {
    expect(isMessageFeedbackCapabilitySupported()).toBe(false);
    expect(isMessageFeedbackCapabilitySupported({})).toBe(false);
    expect(
      isMessageFeedbackCapabilitySupported({ messageFeedback: true }),
    ).toBe(true);
  });

  it('applies optimistically and refetches authoritative state', async () => {
    const messages: IMessage[] = [
      { id: 'message-1', type: 'ai', content: 'Hi' },
    ];
    const updateMessage = vi.fn(
      async (messageId: string, updater: (message: IMessage) => IMessage) => {
        const index = messages.findIndex((message) => message.id === messageId);
        messages[index] = updater(messages[index]);
      },
    );
    const persist = vi.fn(async () => {
      expect(messages[0].feedback).toBe('approved');
      return {
        sessionId: 'session-1',
        messageId: 'message-1',
        feedback: 'approved' as const,
        updatedAt: new Date().toISOString(),
      };
    });
    const refetch = vi.fn().mockResolvedValue(undefined);

    await applyMessageFeedbackOptimistically({
      messages,
      messageId: 'message-1',
      feedback: 'approved',
      updateMessage,
      persist,
      refetch,
    });

    expect(messages[0].feedback).toBe('approved');
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('rolls back on failure and still refetches', async () => {
    const messages: IMessage[] = [
      {
        id: 'message-1',
        type: 'ai' as const,
        content: 'Hi',
        feedback: 'approved' as const,
      },
    ];
    const updateMessage = vi.fn(
      async (messageId: string, updater: (message: IMessage) => IMessage) => {
        const index = messages.findIndex((message) => message.id === messageId);
        messages[index] = updater(messages[index]);
      },
    );
    const refetch = vi.fn().mockResolvedValue(undefined);

    await expect(
      applyMessageFeedbackOptimistically({
        messages,
        messageId: 'message-1',
        feedback: 'disapproved',
        updateMessage,
        persist: vi.fn().mockRejectedValue(new Error('network error')),
        refetch,
      }),
    ).rejects.toThrow('network error');

    expect(messages[0].feedback).toBe('approved');
    expect(updateMessage).toHaveBeenCalledTimes(2);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
