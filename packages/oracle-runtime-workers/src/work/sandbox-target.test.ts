import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SandboxExecutionTarget } from './sandbox-target';
import type {
  SandboxMcpClientFactory,
  SandboxMcpTool,
} from '../plugins/sandbox/sandbox.plugin';
import { artifact, context, executionRequest, manifest } from './test-fixtures';
function fixture(
  options: {
    load?: unknown;
    result?: unknown;
    blocked?: boolean;
    revoked?: boolean;
    blockedLoad?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  const invocations: Array<{ name: string; input: unknown }> = [];
  const headers: unknown[] = [];
  let release: (value: unknown) => void = () => undefined;
  const loadResult = options.blockedLoad
    ? new Promise<unknown>((resolve) => {
        release = resolve;
      })
    : Promise.resolve(
        options.load ?? JSON.stringify({ success: true, skillFiles: [] }),
      );
  const runResult = options.blocked
    ? new Promise<unknown>((resolve) => {
        release = resolve;
      })
    : Promise.resolve(
        options.result ??
          JSON.stringify({
            success: true,
            exitCode: 0,
            output: 'Evidence abc',
          }),
      );
  const tools: SandboxMcpTool[] = [
    'load_skill',
    'sandbox_write_file',
    'sandbox_run',
  ].map((name) => ({
    name,
    description: name,
    schema: z.record(z.string(), z.unknown()),
    invoke: async (input) => {
      invocations.push({ name, input });
      return name === 'sandbox_run'
        ? runResult
        : name === 'load_skill'
          ? loadResult
          : JSON.stringify({ success: true });
    },
  }));
  const factory: SandboxMcpClientFactory = (config) => {
    headers.push(config);
    return { getTools: async () => tools, close: async () => undefined };
  };
  const authorize = vi.fn(async () => {
    if (options.revoked) throw new Error('Current authority revoked');
  });
  const target = new SandboxExecutionTarget({
    context: {
      ...context(),
      ...(options.signal ? { abortSignal: options.signal } : {}),
    },
    mcpClientFactory: factory,
    manifest,
    capsuleCid: manifest.skillId,
    skillPath: '/workspace/skills/research',
    allowedCredentials: { user: ['MY_KEY'], oracle: [] },
    authorizeExecution: authorize,
  });
  return { target, invocations, headers, release, authorize };
}
describe('sandbox target conformance on workerd', () => {
  it('executes only the digest-pinned entrypoint and scrubs short selected credentials', async () => {
    const f = fixture();
    const prepared = await f.target.prepare(executionRequest);
    const receipt = await f.target.execute(prepared);
    expect(receipt.status).toBe('completed');
    expect(receipt.result).toBe('Evidence [REDACTED]');
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.invocations.map((x) => x.name)).toEqual([
      'load_skill',
      'sandbox_write_file',
      'sandbox_run',
    ]);
    expect(JSON.stringify(f.invocations.at(-1)?.input)).toContain(
      "sha256sum 'research.py'",
    );
    expect(JSON.stringify(f.headers)).toContain('abc');
    expect(JSON.stringify(f.headers)).not.toContain('private');
    expect(await f.target.execute(prepared)).toEqual(receipt);
    expect(f.invocations).toHaveLength(3);
    for (const request of [
      { ...prepared.request, workRef: 'topic:other' },
      { ...prepared.request, timeoutMs: 1000 },
      {
        ...prepared.request,
        requestedCapabilities: [{ with: 'ixo:other', can: 'write' }],
      },
    ])
      await expect(f.target.execute({ ...prepared, request })).rejects.toThrow(
        /different work/,
      );
    await expect(
      f.target.execute({
        ...prepared,
        request: { ...prepared.request, principalDID: 'did:ixo:other' },
      }),
    ).rejects.toThrow('Execution principal mismatch');
  });
  it('refuses different work in flight and pins the request across awaits', async () => {
    const f = fixture({ blocked: true });
    const prepared = await f.target.prepare(executionRequest);
    const running = f.target.execute(prepared);
    await vi.waitFor(() =>
      expect(f.invocations.some((x) => x.name === 'sandbox_run')).toBe(true),
    );
    await expect(
      f.target.execute({
        ...prepared,
        request: { ...prepared.request, workRef: 'changed' },
      }),
    ).rejects.toThrow(/different work/);
    prepared.request.workRef = 'model-mutated';
    f.release(JSON.stringify({ success: true, exitCode: 0, output: 'result' }));
    expect((await running).workRef).toBe(executionRequest.workRef);
    expect(await f.target.cancel(prepared)).toBe('requested');
  });
  it('refuses failed load, fresh revocation and unacknowledged execution without claiming completion', async () => {
    const load = fixture({
      load: JSON.stringify({ success: false, error: 'denied' }),
    });
    expect(
      (await load.target.execute(await load.target.prepare(executionRequest)))
        .status,
    ).toBe('failed');
    expect(load.invocations.map((x) => x.name)).toEqual(['load_skill']);
    const revoked = fixture({ revoked: true });
    expect(
      (
        await revoked.target.execute(
          await revoked.target.prepare(executionRequest),
        )
      ).status,
    ).toBe('failed');
    expect(revoked.invocations.some((x) => x.name === 'sandbox_run')).toBe(
      false,
    );
    const lost = fixture({ result: 'unacknowledged' });
    expect(
      (await lost.target.execute(await lost.target.prepare(executionRequest)))
        .status,
    ).toBe('unknown');
  });
  it('checks cancellation after preparation and rejects forged target descriptors before I/O', async () => {
    const abort = new AbortController();
    const blocked = fixture({ blockedLoad: true, signal: abort.signal });
    const running = blocked.target.execute(
      await blocked.target.prepare(executionRequest),
    );
    await vi.waitFor(() =>
      expect(blocked.invocations.map((x) => x.name)).toEqual(['load_skill']),
    );
    abort.abort(new Error('cancelled'));
    blocked.release(JSON.stringify({ success: true, skillFiles: [] }));
    expect((await running).status).toBe('unknown');
    expect(blocked.invocations.map((x) => x.name)).toEqual(['load_skill']);
    const forged = fixture();
    const prepared = await forged.target.prepare(executionRequest);
    await expect(
      forged.target.execute({
        ...prepared,
        target: {
          ...prepared.target,
          providerId: 'forged',
          isolation: 'execution',
        },
      }),
    ).rejects.toThrow(/Target binding mismatch/);
    expect(forged.invocations).toEqual([]);
  });
  it('requires complete artifact identity and hashes staged bytes before execution', async () => {
    const bytes = new TextEncoder().encode('source');
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(hash), (v) =>
      v.toString(16).padStart(2, '0'),
    ).join('');
    const ref = { ...artifact, sha256 };
    const f = fixture();
    await f.target.materializeArtifacts([{ reference: ref, bytes }]);
    const prepared = await f.target.prepare({
      ...executionRequest,
      artifacts: [{ ...ref, cid: 'altered-cid' }],
    });
    expect((await f.target.execute(prepared)).status).toBe('failed');
    expect(f.invocations.some((x) => x.name === 'sandbox_run')).toBe(false);
    const tampered = fixture();
    await tampered.target.materializeArtifacts([
      { reference: ref, bytes: new TextEncoder().encode('tampered') },
    ]);
    expect(
      (
        await tampered.target.execute(
          await tampered.target.prepare({
            ...executionRequest,
            artifacts: [ref],
          }),
        )
      ).status,
    ).toBe('failed');
    const valid = fixture();
    await valid.target.materializeArtifacts([{ reference: ref, bytes }]);
    bytes.fill(0);
    expect(
      (
        await valid.target.execute(
          await valid.target.prepare({ ...executionRequest, artifacts: [ref] }),
        )
      ).status,
    ).toBe('completed');
    expect(valid.invocations).toHaveLength(4);
  });
});
