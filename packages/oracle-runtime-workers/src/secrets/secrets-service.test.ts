import { describe, expect, it } from 'vitest';
import { createSecretsAdapter } from '../do/secrets-adapter';
import { decryptJwe, encryptJwe, type JWK } from './jwe';
import { decryptWithPin } from './pin-cipher';
import {
  RUNTIME_PUBLIC_KEY_ID,
  WorkersSecretsService,
  type SecretsGateway,
} from './secrets-service';

const PRIVATE_JWK: JWK = {
  kty: 'EC',
  x: 'gqkVlNyDyDJh6rjETzi8n-QAkpw650EttnEYuoF5Hik',
  y: 'XDq_aifv0GqaptO9Vi5fXAUFNa5LRu8B8UrbJHN5oog',
  crv: 'P-256',
  d: 'uXjaCXlbT8Xd_E9D0fY-psDml4spIeCyIjFm2aK5ZlA',
};

/**
 * Fixture minted by the chain-client's `encrypt()`
 * (`setup-claim-signing-mnemonics.ts`, AES-256-CBC over `pin.padEnd(32)`) —
 * the ciphertext of `JSON.stringify(PRIVATE_JWK)` under pin `test-pin-1234`.
 * Proves the gateway's account-room key decrypt matches the CLI's publish.
 */
const PIN = 'test-pin-1234';
const PIN_CIPHERTEXT =
  '4de1f0d2bfaedfae35e44308bb048f5e:434e38a01246aadeccdd5918a10006f9e406a7573d8c0c5927d4791e40c76c1f0369a54c512be7d88f2edff4df9f5a732bd5825e6f412abf3f480acda0ddc83bd910f4124489e88b72c5a49a85b2b995562676994e4a1b2c6ce8061cf7bf9e435ab974675fadc331bc29b2eaa93727a744e19f3c30735332f9aa9b31dbf3feb589489424c900ca128d66360bc35c67e99cf5d4e3dfefdbf12fe0c289986e1d868168a52d8084a5336f6bb7f19aac89b56cc80b4b8fd223f1286b18711a12bb53';

interface StateEvent {
  type: string;
  state_key: string;
  content: Record<string, unknown>;
}

/** In-memory Matrix room emulating the gateway's JSON-string RPC surface. */
class MockGateway implements SecretsGateway {
  state = new Map<string, StateEvent>(); // key: `${type}|${stateKey}`
  timeline = new Map<string, { type: string; content: unknown }>();
  redacted: string[] = [];
  calls = { getRoomState: 0, getEvent: 0, sendEvent: 0, sendStateEvent: 0 };
  private seq = 0;

  async getRoomState(): Promise<string> {
    this.calls.getRoomState++;
    return JSON.stringify(
      [...this.state.values()].map((e) => ({
        type: e.type,
        state_key: e.state_key,
        content: e.content,
        sender: '@oracle:server',
        event_id: `$state_${e.type}_${e.state_key}`,
      })),
    );
  }

  async sendEvent(
    _roomId: string,
    type: string,
    content: string,
  ): Promise<string> {
    this.calls.sendEvent++;
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (type === 'm.room.redaction') {
      const redacts = parsed.redacts;
      if (typeof redacts !== 'string') throw new Error('redacts required');
      this.redacted.push(redacts);
      this.timeline.delete(redacts);
      return `$redaction_${this.seq++}`;
    }
    const eventId = `$event_${this.seq++}`;
    this.timeline.set(eventId, { type, content: parsed });
    return eventId;
  }

  async sendStateEvent(
    _roomId: string,
    type: string,
    content: string,
    stateKey = '',
  ): Promise<string> {
    this.calls.sendStateEvent++;
    this.state.set(`${type}|${stateKey}`, {
      type,
      state_key: stateKey,
      content: JSON.parse(content) as Record<string, unknown>,
    });
    return `$state_${this.seq++}`;
  }

  async getEvent(_roomId: string, eventId: string): Promise<string | null> {
    this.calls.getEvent++;
    const hit = this.timeline.get(eventId);
    if (!hit) return null;
    return JSON.stringify({
      event_id: eventId,
      type: hit.type,
      content: hit.content,
      sender: '@user:server',
      origin_server_ts: Date.now(),
    });
  }
}

const ROOM = '!room:server';

function makeService(gateway: MockGateway, withKey = true) {
  return new WorkersSecretsService({
    gateway,
    encryptionKey: withKey ? PRIVATE_JWK : null,
  });
}

/** Seed a portal-style secret: JWE timeline event + index state event. */
async function seedSecret(
  gateway: MockGateway,
  name: string,
  value: string,
): Promise<string> {
  const jwe = await encryptJwe(value, PRIVATE_JWK);
  const eventId = await gateway.sendEvent(
    ROOM,
    'ixo.room.secret',
    JSON.stringify({ value: jwe }),
  );
  await gateway.sendStateEvent(
    ROOM,
    'ixo.room.secret.index',
    JSON.stringify({ eventId, publicKeyId: RUNTIME_PUBLIC_KEY_ID }),
    name,
  );
  return eventId;
}

describe('WorkersSecretsService', () => {
  it('getIndex lists secrets and skips deleted (empty-content) entries', async () => {
    const gateway = new MockGateway();
    await seedSecret(gateway, 'API_KEY', 'v1');
    await seedSecret(gateway, 'OTHER', 'v2');
    await gateway.sendStateEvent(
      ROOM,
      'ixo.room.secret.index',
      '{}',
      'DELETED_ONE',
    );
    // Unrelated state must be ignored.
    await gateway.sendStateEvent(ROOM, 'm.room.name', '{"name":"x"}', '');

    const service = makeService(gateway);
    const index = await service.getIndex(ROOM);
    expect(index.map((e) => e.name).sort()).toEqual(['API_KEY', 'OTHER']);
    expect(index[0]!.publicKeyId).toBe(RUNTIME_PUBLIC_KEY_ID);
  });

  it('getValues decrypts requested names only and caches by eventId', async () => {
    const gateway = new MockGateway();
    await seedSecret(gateway, 'API_KEY', 'secret-value');
    await seedSecret(gateway, 'UNREQUESTED', 'other');

    const service = makeService(gateway);
    const values = await service.getValues(ROOM, ['API_KEY']);
    expect(values).toEqual({ API_KEY: 'secret-value' });
    expect(gateway.calls.getEvent).toBe(1);

    // Second read: cache hit — no timeline fetch.
    await service.getValues(ROOM, ['API_KEY']);
    expect(gateway.calls.getEvent).toBe(1);

    // The value is replaced (new eventId) — the cache must miss and refetch.
    await seedSecret(gateway, 'API_KEY', 'rotated');
    const rotated = await service.getValues(ROOM, ['API_KEY']);
    expect(rotated).toEqual({ API_KEY: 'rotated' });
    expect(gateway.calls.getEvent).toBe(2);
  });

  it('putSecret writes the portal wire shape, redacts the old event and primes the cache', async () => {
    const gateway = new MockGateway();
    const service = makeService(gateway);
    const oldEventId = await seedSecret(gateway, 'TOKEN', 'old');

    await service.putSecret(ROOM, 'TOKEN', 'new-value');

    // Index points at the new timeline event; old ciphertext redacted.
    const indexEntry = gateway.state.get('ixo.room.secret.index|TOKEN')!;
    const newEventId = indexEntry.content.eventId;
    expect(typeof newEventId).toBe('string');
    expect(newEventId).not.toBe(oldEventId);
    expect(indexEntry.content.publicKeyId).toBe(RUNTIME_PUBLIC_KEY_ID);
    expect(gateway.redacted).toEqual([oldEventId]);

    // The stored timeline event is a JWE the oracle key decrypts.
    const stored = gateway.timeline.get(String(newEventId))!;
    const jwe = (stored.content as Record<string, unknown>).value;
    await expect(decryptJwe(String(jwe), PRIVATE_JWK)).resolves.toBe(
      'new-value',
    );

    // Cache primed: the very next read costs no timeline fetch.
    const before = gateway.calls.getEvent;
    await expect(service.getValues(ROOM, ['TOKEN'])).resolves.toEqual({
      TOKEN: 'new-value',
    });
    expect(gateway.calls.getEvent).toBe(before);
  });

  it('deleteSecret clears the index entry, redacts the value and drops the cache', async () => {
    const gateway = new MockGateway();
    const service = makeService(gateway);
    const eventId = await seedSecret(gateway, 'DOOMED', 'bye');
    await service.getValues(ROOM, ['DOOMED']); // warm the cache

    await service.deleteSecret(ROOM, 'DOOMED');

    expect(gateway.state.get('ixo.room.secret.index|DOOMED')!.content).toEqual(
      {},
    );
    expect(gateway.redacted).toEqual([eventId]);
    await expect(service.getIndex(ROOM)).resolves.toEqual([]);
    await expect(service.getValues(ROOM, ['DOOMED'])).resolves.toEqual({});
  });

  it('degrades without a seated key: index lists, values empty, writes throw', async () => {
    const gateway = new MockGateway();
    await seedSecret(gateway, 'API_KEY', 'v1');
    const service = makeService(gateway, false);

    expect(service.hasEncryptionKey()).toBe(false);
    await expect(service.getIndex(ROOM)).resolves.toHaveLength(1);
    await expect(service.getValues(ROOM, ['API_KEY'])).resolves.toEqual({});
    await expect(service.putSecret(ROOM, 'API_KEY', 'x')).rejects.toThrow(
      /no encryption key/,
    );
    // Deletes need no key (parity with the Node service).
    await expect(
      service.deleteSecret(ROOM, 'API_KEY'),
    ).resolves.toBeUndefined();
  });

  it('degrades to empty on a gateway state failure', async () => {
    const gateway = new MockGateway();
    gateway.getRoomState = async () => {
      throw new Error('gateway down');
    };
    const service = makeService(gateway);
    await expect(service.getIndex(ROOM)).resolves.toEqual([]);
    await expect(service.getValues(ROOM, ['X'])).resolves.toEqual({});
  });
});

describe('createSecretsAdapter', () => {
  it('maps the index to the plugin-facing SecretIndex shape', async () => {
    const gateway = new MockGateway();
    await seedSecret(gateway, 'API_KEY', 'v1');
    const adapter = createSecretsAdapter(makeService(gateway));
    await expect(adapter.getIndex(ROOM)).resolves.toEqual({
      API_KEY: { key: 'API_KEY' },
    });
    await expect(adapter.getValues(ROOM, ['API_KEY'])).resolves.toEqual({
      API_KEY: 'v1',
    });
  });
});

describe('decryptWithPin (account-room key cipher)', () => {
  it('decrypts the chain-client encrypt() fixture back to the private JWK', async () => {
    const plaintext = await decryptWithPin(PIN_CIPHERTEXT, PIN);
    expect(JSON.parse(plaintext)).toEqual(PRIVATE_JWK);
  });

  it('rejects a wrong PIN', async () => {
    await expect(decryptWithPin(PIN_CIPHERTEXT, 'wrong-pin')).rejects.toThrow();
  });

  it('rejects a PIN longer than 32 bytes (Node key-length parity)', async () => {
    await expect(
      decryptWithPin(PIN_CIPHERTEXT, 'x'.repeat(33)),
    ).rejects.toThrow(/invalid key length/);
  });
});
