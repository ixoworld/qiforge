import { describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../core/test-fixtures';
import type { ArtifactRef } from '../delivery/types';
import type { Logger, RuntimeContext } from '../plugin-api/types';
import { buildCreateArtifactTool, createArtifactParts } from './tool';

const args = {
  title: 'Plan',
  content: '# Plan',
  message: 'The short version: 3 options.',
  followUp: 'Want me to book it?',
};

const ref: ArtifactRef = {
  artifactId: 'a1',
  title: 'Plan',
  url: 'https://oracle.example/a/a1',
  mime: 'text/markdown',
  bytes: 6,
  expiresAt: '2026-12-01T00:00:00.000Z',
};

function contextWith(logger: Logger): RuntimeContext {
  return { ...makeRuntimeContext(), logger, toolCallId: 'call-1' };
}

function logger(): Logger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('create_artifact', () => {
  it('returns the stored document, keyed by the tool call id', async () => {
    const create = vi.fn(async () => ref);
    const result = await buildCreateArtifactTool(create).handler(
      args,
      contextWith(logger()),
    );
    expect(create).toHaveBeenCalledWith({
      source: 'call-1',
      title: 'Plan',
      content: '# Plan',
    });
    expect(result).toEqual({ ok: true, ...ref });
  });

  it('tries the store once more with the same source before giving up', async () => {
    const create = vi
      .fn<(input: { source: string }) => Promise<ArtifactRef>>()
      .mockRejectedValueOnce(new Error('R2 unavailable'))
      .mockResolvedValueOnce(ref);
    const log = logger();
    const result = await buildCreateArtifactTool(create).handler(
      args,
      contextWith(log),
    );
    expect(result).toEqual({ ok: true, ...ref });
    expect(create.mock.calls.map(([input]) => input.source)).toEqual([
      'call-1',
      'call-1',
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns a failed result when the store keeps throwing, so the reply ends with the message and the question', async () => {
    const log = logger();
    const create = vi.fn(async (): Promise<ArtifactRef> => {
      throw new Error('R2 unavailable');
    });
    const result = await buildCreateArtifactTool(create).handler(
      args,
      contextWith(log),
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: false,
      error: 'The document could not be stored.',
    });
    expect(log.warn).toHaveBeenCalledWith(
      'create_artifact could not store the document: R2 unavailable',
    );
    expect(createArtifactParts(args, JSON.stringify(result))).toEqual([
      { kind: 'text', text: 'The short version: 3 options.' },
      { kind: 'text', text: 'Want me to book it?' },
    ]);
  });

  it('still throws on arguments the schema rejects, so the model can correct the call', async () => {
    await expect(
      buildCreateArtifactTool(async () => ref).handler(
        { ...args, title: '' },
        contextWith(logger()),
      ),
    ).rejects.toThrow();
  });
});
