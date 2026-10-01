/**
 * The runtime's own LLM credentials share the user's oracle room with the
 * secrets the user stores for tools. Plugins see only the latter: the sandbox
 * forwards every secret it sees to code the model writes.
 */
import { describe, expect, it } from 'vitest';
import { BYO_SECRET_NAMES, isRuntimeOnlySecret } from '../llm/byo-catalog';
import type { WorkersSecretsService } from '../secrets/secrets-service';
import { createSecretsAdapter } from './secrets-adapter';

const ROOM = '!oracle:example.org';

function serviceHolding(values: Record<string, string>) {
  const reads: string[][] = [];
  const service = {
    getIndex: async (roomId: string) => {
      expect(roomId).toBe(ROOM);
      return Object.keys(values).map((name, i) => ({
        name,
        eventId: `$${i}`,
        publicKeyId: 'key-1',
      }));
    },
    getValues: async (roomId: string, names: string[]) => {
      expect(roomId).toBe(ROOM);
      reads.push(names);
      return Object.fromEntries(
        names.filter((n) => n in values).map((n) => [n, values[n] ?? '']),
      );
    },
  } satisfies Pick<WorkersSecretsService, 'getIndex' | 'getValues'>;
  return { service, reads };
}

describe('createSecretsAdapter', () => {
  const byo = Object.values(BYO_SECRET_NAMES);
  const stored = {
    GITHUB_TOKEN: 'ghp_user',
    ...Object.fromEntries(byo.map((name) => [name, `credential-${name}`])),
    // A provider added later falls under the same reserved namespace.
    BYO_LLM_FUTURE_API_KEY: 'future',
  };

  it("never lists the runtime's LLM credentials to a plugin", async () => {
    const { service } = serviceHolding(stored);
    const adapter = createSecretsAdapter(service);
    expect(await adapter.getIndex(ROOM)).toEqual({
      GITHUB_TOKEN: { key: 'GITHUB_TOKEN' },
    });
  });

  it('never reads them for a plugin, even when asked by name', async () => {
    const { service, reads } = serviceHolding(stored);
    const adapter = createSecretsAdapter(service);
    expect(
      await adapter.getValues(ROOM, [
        'GITHUB_TOKEN',
        ...byo,
        'BYO_LLM_FUTURE_API_KEY',
      ]),
    ).toEqual({ GITHUB_TOKEN: 'ghp_user' });
    // They are not even decrypted.
    expect(reads).toEqual([['GITHUB_TOKEN']]);
    expect(await adapter.getValues(ROOM, byo)).toEqual({});
    expect(reads).toHaveLength(1);
  });

  it('reserves every BYO secret name, the ChatGPT OAuth tokens included', () => {
    for (const name of byo) expect(isRuntimeOnlySecret(name)).toBe(true);
    expect(isRuntimeOnlySecret(BYO_SECRET_NAMES.chatgpt)).toBe(true);
    expect(isRuntimeOnlySecret('GITHUB_TOKEN')).toBe(false);
  });
});
