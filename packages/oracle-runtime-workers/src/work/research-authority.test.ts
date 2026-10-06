import { describe, expect, it, vi } from 'vitest';
import {
  assertResearchAuthority,
  type TopicResearchAuthority,
  type TopicResearchHost,
} from './research';
import { context } from './test-fixtures';
import type { TopicResearchRequest } from '../tasks/topic-research';
const request: TopicResearchRequest = {
  topic: {
    id: 'one',
    roomId: '!room',
    threadId: '$thread',
    attemptId: 'attempt',
    observedRevision: 'revision1',
  },
  title: 'Research',
  goal: 'Evidence',
  instructions: '',
  sources: [],
  skill: { id: 'capsule1', version: '1', digest: 'a'.repeat(64) },
  capabilities: [],
  credentialNames: [],
};
describe('research authority await boundaries', () => {
  it('rechecks current operation/delegation after a pending Topic authority resolver', async () => {
    let active = true;
    let release: (authority: TopicResearchAuthority) => void = () => undefined;
    const pending = new Promise<TopicResearchAuthority>((resolve) => {
      release = resolve;
    });
    const resolveTopicAuthority = vi.fn(() => pending);
    const host: TopicResearchHost = {
      allowedSkills: [],
      allowedCredentials: { user: [], oracle: [] },
      resolveTopicAuthority,
    };
    const options = {
      request,
      host,
      authorizeCurrent: async () => {
        if (!active) throw new Error('Operation cancelled');
      },
    };
    const result = assertResearchAuthority(
      options,
      context(),
      'ixo:filesystem',
    ).then(
      () => '',
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() =>
      expect(resolveTopicAuthority).toHaveBeenCalledOnce(),
    );
    active = false;
    release({
      allowed: true,
      observedRevision: 'revision1',
      resourceRef: 'ixo:filesystem',
    });
    expect(await result).toMatch(/cancelled/);
  });
  it('rejects changed revisions and workspace resources before any mutation', async () => {
    const host: TopicResearchHost = {
      allowedSkills: [],
      allowedCredentials: { user: [], oracle: [] },
      resolveTopicAuthority: async () => ({
        allowed: true,
        observedRevision: 'revision1',
        resourceRef: 'ixo:filesystem/did:ixo:entity:other',
      }),
    };
    await expect(
      assertResearchAuthority(
        { request, host, authorizeCurrent: async () => undefined },
        context(),
        'ixo:filesystem',
      ),
    ).rejects.toThrow(/does not match/);
    host.resolveTopicAuthority = async () => ({
      allowed: true,
      observedRevision: 'revision2',
      resourceRef: 'ixo:filesystem',
    });
    await expect(
      assertResearchAuthority(
        { request, host, authorizeCurrent: async () => undefined },
        context(),
        'ixo:filesystem',
      ),
    ).rejects.toThrow(/does not match/);
  });
});
