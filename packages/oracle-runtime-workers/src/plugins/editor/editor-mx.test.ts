import { beforeEach, describe, expect, it } from 'vitest';
import { EditorMatrixClient, resolveEditorMatrixClient } from './editor-mx';

const BASE = {
  baseUrl: 'https://mx.test.example',
  userId: '@oracle:test.example',
};

describe('resolveEditorMatrixClient', () => {
  beforeEach(() => {
    EditorMatrixClient.resetForTesting();
  });

  it('reuses the client while the credentials are unchanged', async () => {
    const a = await resolveEditorMatrixClient({ ...BASE, accessToken: 't1' });
    const b = await resolveEditorMatrixClient({ ...BASE, accessToken: 't1' });
    expect(b).toBe(a);
  });

  it('rebuilds the client when the gateway hands out a new access token', async () => {
    const before = await resolveEditorMatrixClient({
      ...BASE,
      accessToken: 'old-token',
    });
    const after = await resolveEditorMatrixClient({
      ...BASE,
      accessToken: 'new-token',
    });
    expect(after).not.toBe(before);
    expect(before.getAccessToken()).toBe('old-token');
    expect(after.getAccessToken()).toBe('new-token');
  });

  it('rebuilds the client when the homeserver changes', async () => {
    const a = await resolveEditorMatrixClient({ ...BASE, accessToken: 't' });
    const b = await resolveEditorMatrixClient({
      ...BASE,
      baseUrl: 'https://other.example',
      accessToken: 't',
    });
    expect(b).not.toBe(a);
    expect(b.getHomeserverUrl()).toBe('https://other.example');
  });

  it('returns a host-provided client untouched', async () => {
    const host = await resolveEditorMatrixClient({ ...BASE, accessToken: 'x' });
    EditorMatrixClient.resetForTesting();
    const got = await resolveEditorMatrixClient({
      ...BASE,
      accessToken: 'ignored',
      matrixClient: host,
    });
    expect(got).toBe(host);
  });
});
