import { describe, expect, it } from 'vitest';
import { VfsClient } from '../plugins/vfs/vfs-client';
import { markdownDigest } from '../tasks/topic-deliverables';
import { VfsWorkspaceAdapter } from './vfs-workspace';
import type { ExecutionTargetProvider } from './contracts';
import { SandboxExecutionTarget } from './sandbox-target';
import { context, manifest } from './test-fixtures';
function fixture(
  authorizeMutation: () => Promise<void> = async () => undefined,
  afterPut: () => void = () => undefined,
) {
  const files = new Map<
    string,
    {
      id: string;
      path: string;
      version: number;
      cid: string;
      contentHash: string;
      content: string;
    }
  >();
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (init?.method === 'POST') {
      const path = url.searchParams.get('path') ?? '';
      if (files.has(path))
        return Response.json({ message: 'Conflict' }, { status: 409 });
      if (typeof init.body !== 'string')
        throw new Error('Expected UTF8 content');
      const file = {
        id: `file${files.size + 1}`,
        path,
        version: 1,
        cid: `cid${files.size + 1}`,
        contentHash: await markdownDigest(init.body),
        content: init.body,
      };
      files.set(path, file);
      afterPut();
      return Response.json(file);
    }
    if (url.pathname.endsWith('/files'))
      return Response.json({ files: [...files.values()] });
    const id = url.pathname.split('/')[4];
    const file = [...files.values()].find((x) => x.id === id);
    return file
      ? new Response(file.content)
      : new Response('not found', { status: 404 });
  };
  const client = new VfsClient({
    baseUrl: 'https://vfs.example/api/fs',
    mint: async () => ({ bearer: 'fresh-token' }),
    timeoutMs: 5000,
    fetchImpl,
  });
  return {
    workspace: new VfsWorkspaceAdapter(
      client,
      () => '2026-10-07T00:00:00.000Z',
      authorizeMutation,
    ),
    files,
    calls,
  };
}
const binding = {
  version: 1,
  workspaceId: 'one',
  principalDID: 'did:ixo:user1',
  resourceRef: 'ixo:filesystem',
  rootPath: '/.workspaces/one/',
} satisfies Parameters<VfsWorkspaceAdapter['open']>[0];
const provenance = {
  principalDID: 'did:ixo:user1',
  workRef: 'topic:one/attempt',
  inputDigest: 'a'.repeat(64),
};
describe('VFS workspace immutable version and replacement conformance', () => {
  it('restores selected work versions under current authorization and verifies committed hashes', async () => {
    const f = fixture();
    await f.workspace.open(binding);
    const evidence = await f.workspace.put(
      'evidence.md',
      'Evidence',
      'text/markdown',
    );
    const revision = await f.workspace.commit('Evidence commit', provenance);
    const ref = f.workspace.getRevisionArtifact();
    if (!ref) throw new Error('Missing revision');
    expect(await f.workspace.commit('Evidence commit', provenance)).toEqual(
      revision,
    );
    await f.workspace.close();
    await f.workspace.open(binding);
    expect(await f.workspace.restore(ref)).toEqual(revision);
    const target: ExecutionTargetProvider = new SandboxExecutionTarget({
      context: context(),
      manifest,
      capsuleCid: manifest.skillId,
      skillPath: '/workspace/skills/research',
      allowedCredentials: { user: [], oracle: [] },
      authorizeExecution: async () => undefined,
    });
    expect(await f.workspace.materialize(target)).toEqual([evidence]);
    expect(
      f.calls.some((x) =>
        x.includes(`/files/${evidence.fileId}/versions/1/content`),
      ),
    ).toBe(true);
    expect(f.calls.some((x) => x.includes('.oracles'))).toBe(false);
    const file = f.files.get(evidence.path);
    if (!file) throw new Error('Missing evidence');
    file.content = 'tampered';
    await expect(f.workspace.materialize(target)).rejects.toThrow(
      /digest mismatch/,
    );
  });
  it('does not accept a committed artifact or continue mutations after authority changes during PUT', async () => {
    let authorized = true;
    const f = fixture(
      async () => {
        if (!authorized) throw new Error('Topic authority changed');
      },
      () => {
        authorized = false;
      },
    );
    await f.workspace.open(binding);
    await expect(
      f.workspace.put('evidence.md', 'Evidence', 'text/markdown'),
    ).rejects.toThrow(/authority changed/);
    expect(f.files.size).toBe(1);
    expect(await f.workspace.snapshot()).toEqual([]);
    await expect(
      f.workspace.put('report.md', 'Report', 'text/markdown'),
    ).rejects.toThrow(/authority changed/);
    expect(f.files.size).toBe(1);
  });
  it('clears revision receipts when replacing a workspace and recovers identical content writes', async () => {
    const f = fixture();
    await f.workspace.open(binding);
    const evidence = await f.workspace.put(
      'evidence.md',
      'Evidence',
      'text/markdown',
    );
    expect(
      await f.workspace.put('evidence.md', 'Evidence', 'text/markdown'),
    ).toEqual(evidence);
    const glob = f.calls.find(
      (x) => x.startsWith('GET ') && x.includes('/files?'),
    );
    if (!glob) throw new Error('Missing reconciliation lookup');
    expect(
      new URL(`https://vfs.example${glob.slice(4)}`).searchParams.get('path')
        ?.length,
    ).toBeLessThan(50);
    await f.workspace.commit('commit', provenance);
    expect(f.workspace.getRevisionArtifact()).toBeDefined();
    await f.workspace.open({
      ...binding,
      workspaceId: 'two',
      rootPath: '/.workspaces/two/',
    });
    expect(f.workspace.getRevisionArtifact()).toBeUndefined();
    expect(await f.workspace.snapshot()).toEqual([]);
    await expect(f.workspace.restore(evidence)).rejects.toThrow(
      /outside this workspace/,
    );
  });
});
