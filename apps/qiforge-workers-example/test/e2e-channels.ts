import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  createInvocation,
  serializeInvocation,
  signerFromMnemonic,
} from '@ixo/ucan';
import { mintAuthInvocation, type HarnessAccount } from './lib/harness';
import {
  createE2eeClient,
  loginWithPassword,
  type E2eeClient,
} from './lib/matrix-client';

interface Binding {
  bound: boolean;
  bindingId?: string;
  bindingRevision?: number;
  userDid?: string;
  companionRoomId?: string;
}
interface Diagnostics {
  inboundCount: number;
  conversation: { session_id: string } | null;
  lastInbound: {
    status: string;
    request_id: string;
    run_id: string | null;
  } | null;
  deliveries: { status: string; count: number }[];
}
interface Message {
  id: string;
  type: string;
  content: string;
  metadata?: {
    'org.ixo.qi.origin'?: {
      v: number;
      transport: string;
      binding_id: string;
      remote_ref: string;
    };
  };
}
const required = [
  'CHANNEL_GATEWAY_URL',
  'AUTH_HUB_URL',
  'AUTH_HUB_DID',
  'ORACLE_URL',
  'ORACLE_DID',
  'MATRIX_TEST_BASE_URL',
  'CHANNEL_E2E_ORACLE_MATRIX_USER_ID',
  'CHANNEL_E2E_SUBJECT',
  'CHANNEL_SERVICE_AUTH_TOKEN',
  'CHANNEL_STATUS_TOKEN',
  'CHANNEL_SUBJECT_HMAC_KEY',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_BUSINESS_ACCOUNT_ID',
  'WHATSAPP_PHONE_NUMBER_ID',
  'ACCOUNT_JSON',
];
const results: {
  check: string;
  evidence: 'automatic' | 'operator';
  at: string;
}[] = [];
const value = (name: string): string => {
  const result = process.env[name];
  assert.ok(result, `Missing ${name}`);
  return result;
};
const digest = (key: string, input: string): string =>
  createHmac('sha256', key).update(input).digest('hex');
const pass = (
  check: string,
  evidence: 'automatic' | 'operator' = 'automatic',
): void => {
  results.push({ check, evidence, at: new Date().toISOString() });
  console.log(`PASS ${check} (${evidence})`);
};
async function json<T>(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(new URL(path, base), {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `${path} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
async function until<T>(
  read: () => Promise<T>,
  accept: (result: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const result = await read();
    if (accept(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out at ${label}`);
}
async function confirm(prompt: string): Promise<void> {
  assert.ok(
    stdin.isTTY,
    'WorkOS and Qi.Space checkpoints require an interactive operator',
  );
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    assert.equal(
      (await reader.question(`${prompt}\nType verified to continue: `)).trim(),
      'verified',
      'Operator checkpoint incomplete',
    );
  } finally {
    reader.close();
  }
}

async function remoteId(): Promise<string> {
  if (process.env.CHANNEL_E2E_INITIAL_MESSAGE_ID)
    return value('CHANNEL_E2E_INITIAL_MESSAGE_ID');
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const id = (
      await reader.question(
        'Enter the original Hi message ID from the secured test webhook capture (used only to replay that event): ',
      )
    ).trim();
    assert.ok(id && id.length <= 512, 'A real inbound message ID is required');
    return id;
  } finally {
    reader.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(
      'Run the real Channels acceptance scenario with a dedicated operator-controlled WhatsApp number. It sends messages and revokes the test binding. Set CHANNEL_E2E_ALLOW_WRITES=1 and the environment variables listed in docs/testing/channels-acceptance.md. --check-config validates configuration without network calls. WorkOS login and the final Qi.Space UI checkpoint remain interactive.',
    );
    return;
  }
  for (const name of required) value(name);
  for (const name of [
    'CHANNEL_GATEWAY_URL',
    'AUTH_HUB_URL',
    'ORACLE_URL',
    'MATRIX_TEST_BASE_URL',
  ]) {
    const url = new URL(value(name));
    assert.ok(
      url.protocol === 'https:' ||
        ['localhost', '127.0.0.1'].includes(url.hostname),
      `${name} requires HTTPS outside the local harness`,
    );
    assert.ok(
      !url.username && !url.password && !url.search && !url.hash,
      `${name} must not contain credentials or query data`,
    );
  }
  assert.match(value('CHANNEL_E2E_SUBJECT'), /^\d{5,20}$/);
  if (process.argv.includes('--check-config')) {
    console.log('Configuration shape valid. No endpoints contacted.');
    return;
  }
  assert.equal(
    process.env.CHANNEL_E2E_ALLOW_WRITES,
    '1',
    'This scenario sends to the dedicated test number and revokes its binding; set CHANNEL_E2E_ALLOW_WRITES=1 only for an authorized test',
  );
  const gateway = value('CHANNEL_GATEWAY_URL');
  const auth = value('AUTH_HUB_URL');
  const subject = value('CHANNEL_E2E_SUBJECT');
  const serviceHeaders = {
    'content-type': 'application/json',
    'x-channels-service-key': value('CHANNEL_SERVICE_AUTH_TOKEN'),
  };
  const resolve = (): Promise<Binding> =>
    json(auth, '/api/internal/channels/resolve', {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify({
        provider: 'whatsapp',
        providerSubject: subject,
        issueGrant: false,
      }),
    });
  const fingerprint = digest(
    value('CHANNEL_SUBJECT_HMAC_KEY'),
    `whatsapp\0${subject}`,
  );
  const diagnostics = (): Promise<Diagnostics> =>
    json(gateway, `/diagnostics/${fingerprint}`, {
      headers: { authorization: `Bearer ${value('CHANNEL_STATUS_TOKEN')}` },
    });
  const post = async (id: string, text: string): Promise<void> => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: value('WHATSAPP_BUSINESS_ACCOUNT_ID'),
          changes: [
            {
              field: 'messages',
              value: {
                metadata: {
                  phone_number_id: value('WHATSAPP_PHONE_NUMBER_ID'),
                },
                messages: [
                  {
                    from: subject,
                    id,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await json(gateway, '/webhooks/whatsapp', {
      method: 'POST',
      body,
      headers: {
        'x-hub-signature-256': `sha256=${digest(value('WHATSAPP_APP_SECRET'), body)}`,
      },
    });
  };
  let client: E2eeClient | undefined;
  let logout: (() => Promise<void>) | undefined;
  const runId = randomUUID();
  const evidencePath =
    process.env.CHANNEL_E2E_EVIDENCE ?? `/tmp/ixo-channels-e2e-${runId}.json`;
  try {
    assert.equal(
      (await json<{ ready: boolean }>(gateway, '/ready')).ready,
      true,
    );
    assert.equal(
      (await resolve()).bound,
      false,
      'Use a never-linked dedicated subject for this scenario',
    );
    assert.equal(
      (await diagnostics()).inboundCount,
      0,
      'Use a never-seen subject; existing rows would hide duplicate provisioning',
    );
    await confirm(
      'Send Hi from the never-seen dedicated WhatsApp number to the configured business number. This real message establishes the provider service window. Keep its message ID in the secured test webhook capture; do not enable raw production webhook logging.',
    );
    const admitted = await until(
      diagnostics,
      (d) =>
        d.lastInbound?.status === 'link_sent' &&
        d.deliveries.some((r) => r.status === 'sent'),
      'onboarding delivery',
    );
    const helloId = await remoteId();
    assert.equal(
      admitted.lastInbound?.request_id,
      `wa:${digest(value('CHANNEL_SUBJECT_HMAC_KEY'), `whatsapp\0${subject}\0${helloId}`)}`,
      'Replay ID must identify the actual first message',
    );
    await Promise.all([
      post(helloId, 'Hi'),
      post(helloId, 'Hi'),
      post(helloId, 'Hi'),
    ]);
    assert.equal((await diagnostics()).inboundCount, 1);
    assert.equal(admitted.inboundCount, 1);
    assert.equal((await resolve()).bound, false);
    pass(
      'Duplicate onboarding webhooks persist one inbound without creating an identity',
    );
    await confirm(
      'Open the link received on the dedicated WhatsApp number. Complete WorkOS authentication and explicit channel consent. Export this exact canonical test account to ACCOUNT_JSON using the existing harness account format. Do not create another harness identity.',
    );
    const binding = await until(resolve, (b) => b.bound, 'binding activation');
    assert.ok(
      binding.bindingId &&
        binding.bindingRevision &&
        binding.userDid &&
        binding.companionRoomId,
    );
    const account = JSON.parse(
      await readFile(value('ACCOUNT_JSON'), 'utf8'),
    ) as HarnessAccount;
    assert.equal(account.did, binding.userDid);
    assert.equal(account.did, `did:ixo:${account.address}`);
    assert.ok(
      account.edSigningMnemonic &&
        account.matrixPassword &&
        account.matrixUserId,
      'The canonical test-account export is incomplete',
    );
    const { signer } = await signerFromMnemonic(
      account.edSigningMnemonic,
      account.did as `did:ixo:${string}`,
    );
    const manageHeaders = async (): Promise<Record<string, string>> => ({
      'x-auth-type': 'ucan',
      authorization: `Bearer ${await serializeInvocation(await createInvocation({ issuer: signer, audience: value('AUTH_HUB_DID'), capability: { can: 'auth/channels/manage', with: `ixo:auth-hub:user:${account.address}` }, proofs: [], expiration: Math.floor(Date.now() / 1000) + 60 }))}`,
    });
    const listBindings = async (): Promise<{
      channels: { id: string; status: string }[];
    }> => json(auth, '/api/channels', { headers: await manageHeaders() });
    assert.equal(
      (await listBindings()).channels.filter((b) => b.status === 'active')
        .length,
      1,
    );
    pass('One active binding belongs to the canonical registered DID');
    const login = await loginWithPassword(
      value('MATRIX_TEST_BASE_URL'),
      account.matrixUserId,
      account.matrixPassword,
    );
    assert.equal(login.userId, account.matrixUserId);
    logout = async () => {
      await fetch(
        new URL('/_matrix/client/v3/logout', value('MATRIX_TEST_BASE_URL')),
        {
          method: 'POST',
          headers: { authorization: `Bearer ${login.accessToken}` },
        },
      );
    };
    client = await createE2eeClient(value('MATRIX_TEST_BASE_URL'), login);
    const mx = client.mx;
    const roomId = binding.companionRoomId;
    const beforeRooms = (await mx.getJoinedRooms()).joined_rooms.sort();
    assert.ok(
      beforeRooms.includes(roomId),
      'Canonical Companion room must be joined',
    );
    const encryption = await mx.getStateEvent(roomId, 'm.room.encryption', '');
    assert.equal(encryption.algorithm, 'm.megolm.v1.aes-sha2');
    pass(
      'Canonical Matrix account can open the existing encrypted Companion room',
    );
    const turnId = `channels-e2e-${runId}-turn`;
    const text = `Reply with exactly CHANNELS-${runId}`;
    await Promise.all([post(turnId, text), post(turnId, text)]);
    const completed = await until(
      diagnostics,
      (d) => d.lastInbound?.status === 'answered',
      'Companion completion',
    );
    assert.equal(completed.inboundCount, 2);
    assert.ok(
      completed.conversation?.session_id && completed.lastInbound?.run_id,
    );
    const sessionId = completed.conversation.session_id;
    const history = async (): Promise<{ messages: Message[] }> =>
      json(
        value('ORACLE_URL'),
        `/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`,
        {
          headers: {
            'x-auth-type': 'ucan',
            authorization: `Bearer ${await mintAuthInvocation(account, value('ORACLE_DID'))}`,
          },
        },
      );
    const transcript = await until(
      history,
      (h) => h.messages.some((m) => m.type === 'ai'),
      'canonical session history',
    );
    const human = transcript.messages.filter(
      (m) => m.type === 'human' && m.content === text,
    );
    assert.equal(human.length, 1);
    assert.deepEqual(human[0]?.metadata?.['org.ixo.qi.origin'], {
      v: 1,
      transport: 'whatsapp',
      binding_id: binding.bindingId,
      remote_ref: `hmac:${digest(value('CHANNEL_SUBJECT_HMAC_KEY'), `whatsapp\0${subject}\0${turnId}`)}`,
    });
    pass(
      'Duplicate channel turn creates one canonical session message with exact provenance',
    );
    await until(
      async () => {
        const events = mx.getRoom(roomId)?.getLiveTimeline().getEvents() ?? [];
        for (const event of events) {
          await mx.decryptEventIfNeeded(event);
          const content = event.getContent();
          if (
            event.getWireType() === 'm.room.encrypted' &&
            event.getSender() === value('CHANNEL_E2E_ORACLE_MATRIX_USER_ID') &&
            content['org.ixo.qi.origin']?.remote_ref ===
              human[0]?.metadata?.['org.ixo.qi.origin']?.remote_ref
          )
            return true;
        }
        return false;
      },
      Boolean,
      'decrypted canonical Matrix provenance',
    );
    pass(
      'Real Matrix E2EE event decrypts with the expected trusted oracle sender and origin',
    );
    await confirm(
      'Verify the response arrived in WhatsApp. Open Qi.Space and verify the same DID, Matrix account, Companion room and channel-created session are visible.',
    );
    pass(
      'WhatsApp delivery and Qi.Space identity/session continuity',
      'operator',
    );
    const beforeReplay = await diagnostics();
    await post(turnId, text);
    const replay = await diagnostics();
    assert.deepEqual(replay.lastInbound, beforeReplay.lastInbound);
    assert.equal(replay.conversation?.session_id, sessionId);
    assert.deepEqual(
      (await mx.getJoinedRooms()).joined_rooms.sort(),
      beforeRooms,
    );
    assert.equal((await resolve()).companionRoomId, roomId);
    assert.equal((await resolve()).userDid, account.did);
    pass('Replay reuses the same run, session, DID and Matrix room');
    await json(auth, `/api/channels/${encodeURIComponent(binding.bindingId)}`, {
      method: 'DELETE',
      headers: await manageHeaders(),
    });
    assert.equal((await resolve()).bound, false);
    await post(`channels-e2e-${runId}-revoked`, 'This must not invoke Qi');
    const revoked = await until(
      diagnostics,
      (d) => d.lastInbound?.status === 'link_sent',
      'post-revocation onboarding',
    );
    assert.equal(revoked.lastInbound?.run_id, null);
    assert.deepEqual((await history()).messages, transcript.messages);
    assert.deepEqual(
      (await mx.getJoinedRooms()).joined_rooms.sort(),
      beforeRooms,
    );
    pass(
      'Revocation blocks new Qi turns while canonical history and joined rooms remain intact',
    );
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          status: 'passed',
          runId,
          at: new Date().toISOString(),
          results,
          limits: [
            'WorkOS authentication and Qi.Space visual checks are operator checkpoints',
            'Chain and homeserver global resource counts need deployment inventory evidence',
            'Fault-injection matrix is a separate required release run',
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(`Evidence saved to ${evidencePath}`);
  } catch (error) {
    await writeFile(
      evidencePath,
      JSON.stringify(
        { status: 'failed', runId, at: new Date().toISOString(), results },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    throw error;
  } finally {
    client?.stop();
    await logout?.();
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Channel acceptance failed',
  );
  process.exitCode = 1;
});
