// A single tool-heavy turn on the deployed devnet worker: CALLS sequential
// `sandbox_run` calls, each chained on the previous result, so one turn
// drives LangGraph's step counter far past a small `recursionLimit`.
// Prints every tool call with its timing, any SSE error (a
// `GraphRecursionError` shows up here) and a one-line RESULT summary.
//
//   ACCOUNT=devnet-user-2 CALLS=32 [MODEL=<openrouter slug>] \
//     pnpm exec tsx test/load/tool-heavy-turn.mts
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
const CALLS = Number(process.env.CALLS ?? 32);
const MODEL = process.env.MODEL;

const prompt = `This is a tool-loop test of the runtime, not a real task. Use the sandbox_run tool exactly ${CALLS} times, strictly one call at a time. Call 1 runs the Python code print(1). Every later call must run print(<the number the previous call printed> + 1), so call k prints k. Rules: never issue two tool calls in the same step, never batch or skip, never stop early, never ask for confirmation, use no other tools. When call ${CALLS} has printed ${CALLS}, reply with exactly that number and nothing else.`;

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

const dep = await authed('POST', '/delegation', {
  raw: delegation,
  expiration: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
});
console.log(`delegation deposit: ${dep.status}`);
const lane = await authed('GET', '/byo-llm/status');
console.log(`byo status: ${lane.status} ${lane.text.slice(0, 200)}`);
if (MODEL) console.log(`model: ${MODEL}`);

const client = new ChatClient(ORACLE_URL, { invocation, delegation });
const sessionId = await client.createSession();
console.log(`session ${sessionId}`);

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let toolCalls = 0;
const errors: string[] = [];
const onEvent = (e: SSEEvent) => {
  if (e.event === 'tool_call') {
    const name = String(e.data.toolName ?? e.data.name ?? '?');
    const status = String(e.data.status ?? '');
    if (status !== 'done') {
      toolCalls += 1;
      if (toolCalls % 5 === 0)
        console.log(`[${stamp()}] tool calls so far: ${toolCalls} (${name})`);
    }
  } else if (e.event === 'error') {
    const text = JSON.stringify(e.data).slice(0, 600);
    errors.push(text);
    console.log(`[${stamp()}] ERROR ${text}`);
  } else if (e.event === 'done') {
    console.log(`[${stamp()}] done`);
  }
};

console.log(`[${stamp()}] sending (${CALLS} chained calls requested)`);
const result = await client.stream(sessionId, prompt, {
  onEvent,
  ...(MODEL ? { body: { model: MODEL } } : {}),
});
const secs = (result.durationMs / 1000).toFixed(1);
console.log(`request id: ${result.requestId}`);
console.log(`answer (${result.text.length} chars): ${result.text.slice(0, 200)}`);
console.log(
  `RESULT: ${errors.length ? 'error' : 'ok'} http=${result.status} toolCalls=${toolCalls} seconds=${secs} errors=${errors.length}${errors.length ? ' first=' + errors[0] : ''}`,
);
process.exit(0);
