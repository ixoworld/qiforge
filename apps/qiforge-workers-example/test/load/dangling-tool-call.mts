// Does a session survive a turn that dies mid-tool-call? For each model: start
// a turn that runs a slow sandbox_run, kill it while the tool runs (MODE=reset
// → the object is forcibly reset like a host drain via the debug route;
// MODE=abort → the user's own /messages/abort), then send a plain second turn
// on the same session and report whether the provider accepts the history.
//
//   ACCOUNT=devnet-user-2 MODE=reset MODELS=openai/gpt-5.6-luna,anthropic/claude-sonnet-5 \
//     pnpm exec tsx test/load/dangling-tool-call.mts
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  mintAuthInvocation,
  mintDelegation,
  VFS_OWNER_COPY_CAPABILITY,
  type HarnessAccount,
} from '../lib/harness';
import { ChatClient, type SSEEvent } from '../lib/chat-client';

const SP = fileURLToPath(new URL('../.devnet-accounts', import.meta.url));
const ORACLE_URL =
  process.env.ORACLE_URL ?? 'https://mike-devnet-oracle.ixo-api.workers.dev';
const ORACLE_DID =
  process.env.ORACLE_DID ??
  'did:ixo:ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3';
const ACCOUNT = process.env.ACCOUNT ?? 'devnet-user-2';
const MODE = (process.env.MODE ?? 'reset') as 'reset' | 'abort';
const MODELS = (
  process.env.MODELS ??
  'openai/gpt-5.6-luna,anthropic/claude-sonnet-5,google/gemini-3.5-flash,byo:chatgpt/gpt-5.6-luna'
).split(',');
const KILL_AFTER_MS = Number(process.env.KILL_AFTER_MS ?? 2500);

const SLOW_TURN = `Use the sandbox_run tool exactly once to run this Python code and nothing else:
import time
time.sleep(40)
print('slept')
After the tool returns, reply with the single word slept.`;
const PLAIN_TURN = 'Reply with the single word OK and nothing else.';

const a = JSON.parse(readFileSync(`${SP}/${ACCOUNT}.json`, 'utf8')) as Record<
  string,
  string
>;
const acct: HarnessAccount = {
  name: ACCOUNT,
  address: a.address!,
  did: a.did!,
  edSigningMnemonic: a.edSigningMnemonic!,
  matrixUserId: a.matrixUserId!,
  matrixPassword: a.matrixPassword!,
  matrixMnemonic: '',
};
const invocation = await mintAuthInvocation(acct, ORACLE_DID, 900);
const delegation = await mintDelegation(acct, ORACLE_DID, [
  { can: '*', with: 'ixo:oracle' },
  { can: '*', with: 'ixo:memory' },
  { can: '*', with: 'ixo:sandbox' },
  { can: '*', with: 'ixo:skills' },
  VFS_OWNER_COPY_CAPABILITY,
]);
const authed = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(ORACLE_URL + path, {
    method,
    headers: {
      authorization: `Bearer ${invocation}`,
      'x-auth-type': 'ucan',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, text: await r.text() };
};
await authed('POST', '/delegation', {
  raw: delegation,
  expiration: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
});
const client = new ChatClient(ORACLE_URL, { invocation, delegation });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TranscriptMessage {
  type: string;
  content: string;
  toolCalls?: { name: string; status?: string; output?: string }[];
}

for (const model of MODELS) {
  console.log(`\n===== ${model} (${MODE})`);
  const sessionId = await client.createSession();
  const t0 = Date.now();
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  let killed = false;
  let toolSeen = false;
  const firstTurnErrors: string[] = [];
  const kill = async () => {
    if (killed) return;
    killed = true;
    await sleep(KILL_AFTER_MS);
    if (MODE === 'reset') {
      const r = await authed('POST', '/debug/object/abort');
      console.log(`[${stamp()}] object reset → ${r.status} ${r.text}`);
    } else {
      const r = await client.abort(sessionId);
      console.log(`[${stamp()}] abort → ${JSON.stringify(r)}`);
    }
  };
  const onEvent = (e: SSEEvent) => {
    if (e.event === 'tool_call' && !toolSeen) {
      toolSeen = true;
      console.log(
        `[${stamp()}] tool_call ${String(e.data.toolName ?? e.data.name)} ${String(e.data.status ?? '')}`,
      );
      void kill();
    } else if (e.event === 'error') {
      firstTurnErrors.push(JSON.stringify(e.data).slice(0, 300));
      console.log(`[${stamp()}] turn 1 error ${firstTurnErrors.at(-1)}`);
    }
  };
  try {
    const r1 = await client.stream(sessionId, SLOW_TURN, {
      onEvent,
      body: { model },
    });
    console.log(
      `[${stamp()}] turn 1 ended: http ${r1.status}, ${r1.events.length} events, toolSeen=${toolSeen}`,
    );
  } catch (err) {
    console.log(
      `[${stamp()}] turn 1 stream threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!toolSeen) {
    console.log(`RESULT model=${model} mode=${MODE} skipped=no-tool-call`);
    continue;
  }
  await sleep(3000);

  const tr = await authed('GET', `/messages/${encodeURIComponent(sessionId)}`);
  let dangling = 'unknown';
  try {
    const { messages } = JSON.parse(tr.text) as {
      messages: TranscriptMessage[];
    };
    const last = messages.at(-1);
    const pending = (last?.toolCalls ?? []).filter(
      (tc) => tc.status !== 'done' || tc.output === undefined,
    );
    dangling =
      last?.type === 'ai' && pending.length > 0
        ? `yes(${pending.map((p) => `${p.name}:${p.status ?? '-'}`).join(',')})`
        : 'no';
    console.log(
      `[${stamp()}] transcript: ${messages.length} messages, last=${last?.type}, dangling=${dangling}`,
    );
  } catch {
    console.log(
      `[${stamp()}] transcript unreadable: ${tr.status} ${tr.text.slice(0, 120)}`,
    );
  }

  const secondErrors: string[] = [];
  const r2 = await client.stream(sessionId, PLAIN_TURN, {
    body: { model },
    onEvent: (e) => {
      if (e.event === 'error')
        secondErrors.push(JSON.stringify(e.data).slice(0, 500));
    },
  });
  const ok =
    secondErrors.length === 0 && r2.status === 200 && r2.text.trim().length > 0;
  console.log(
    `[${stamp()}] turn 2: http ${r2.status}, text="${r2.text.trim().slice(0, 40)}", errors=${secondErrors.length}`,
  );
  console.log(
    `RESULT model=${model} mode=${MODE} dangling=${dangling} turn2=${ok ? 'ok' : 'FAIL'}${secondErrors.length ? ' detail=' + secondErrors[0] : ''}`,
  );
}
process.exit(0);
