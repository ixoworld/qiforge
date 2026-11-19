/**
 * The pieces of a turn restricted to the person's own provider: the denied
 * platform adapter (builds, binds tools, fails each call) and the denied
 * Decision evaluator (no provider).
 */
import { DecisionProviderUnavailableError } from '@ixo/common/ai/decisions';
import { tool } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  deniedDecisions,
  deniedPlatformLlm,
  PlatformModelsDeniedError,
} from './platform-models-policy';

describe('platform models denied', () => {
  it('a denied model builds and binds tools, and each call fails with a clear error', async () => {
    const model = deniedPlatformLlm().get('vision');
    const lookup = tool(async () => 'x', {
      name: 'lookup',
      description: 'Look something up.',
      schema: z.object({ q: z.string() }),
    });
    const bound = model.bindTools?.([lookup]);
    expect(bound).toBeDefined();
    const error = await model.invoke('hi').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PlatformModelsDeniedError);
    expect(String(error)).toContain('"vision" model');
    expect(String(error)).toContain('own model provider');
  });

  it('denied Decisions reject as "no provider"', async () => {
    const decisions = deniedDecisions();
    await expect(
      decisions.evaluateByName('anything', {}),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
  });
});
