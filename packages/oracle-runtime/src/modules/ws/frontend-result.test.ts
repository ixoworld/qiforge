import { describe, expect, it } from 'vitest';
import { authenticatedFrontendResult } from './frontend-result.js';

describe('authenticated frontend results', () => {
  it('rejects cross-session and unauthenticated results', () => {
    expect(
      authenticatedFrontendResult('a', 'did:example:alice', {
        toolCallId: 'one',
        sessionId: 'b',
      }),
    ).toBeNull();
    expect(
      authenticatedFrontendResult('a', undefined, { toolCallId: 'one' }),
    ).toBeNull();
  });
  it('retains compatibility with clients omitting sessionId without trusting payload routing', () => {
    expect(
      authenticatedFrontendResult('a', 'did:example:alice', {
        toolCallId: 'one',
        result: 'saved',
      }),
    ).toMatchObject({ sessionId: 'a', toolCallId: 'one', result: 'saved' });
  });
});
