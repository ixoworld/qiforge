// A single long agent turn on the deployed devnet worker: a deep-research
// request that drives the firecrawl sub-agent through many searches and page
// reads before a long synthesis. Reports the wall-clock time, the tool calls
// with their timing, the lane the turn ran on and the object's state after.
//
//   ACCOUNT=devnet-user-2 PROMPT_FILE=… pnpm exec tsx test/load/deep-research.mts
//
// The account should be connected to a BYO lane (byo-chatgpt-e2e.mts) so the
// run does not spend platform OpenRouter credit.
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

const DEFAULT_PROMPT = `Do a thorough deep-research report for me. Topic: the current state (2025–2026) of digital MRV (measurement, reporting and verification) for carbon credits — sensors, satellite data, blockchain registries and AI verification.

Method: search the web, open and read at least 8 distinct sources in full (organisations, standards bodies, registries, recent news), then write a structured report of roughly 1,500 words with these sections: executive summary; how dMRV differs from traditional MRV; at least 6 named organisations or projects compared in a table (what they measure, technology, registry or standard they work with, status in 2026); open problems; a short outlook. Cite every claim with the source URL. Do not stop at the first search — keep researching until you have covered the ground, then write the report in full.`;

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
const prompt = process.env.PROMPT_FILE
  ? readFileSync(process.env.PROMPT_FILE, 'utf8')
  : DEFAULT_PROMPT;

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

const client = new ChatClient(ORACLE_URL, { invocation, delegation });
const sessionId = await client.createSession();
console.log(`session ${sessionId}`);

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const toolCounts = new Map<string, number>();
let messageChunks = 0;
let reasoningChunks = 0;
const onEvent = (e: SSEEvent) => {
  if (e.event === 'tool_call') {
    const name = String(e.data.toolName ?? e.data.name ?? '?');
    const status = String(e.data.status ?? '');
    if (status !== 'done') {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
    console.log(`[${stamp()}] tool_call ${name} ${status}`);
  } else if (e.event === 'action_call') {
    console.log(`[${stamp()}] action_call ${String(e.data.toolName ?? '')}`);
  } else if (e.event === 'error') {
    console.log(`[${stamp()}] ERROR ${JSON.stringify(e.data).slice(0, 400)}`);
  } else if (e.event === 'done') {
    console.log(`[${stamp()}] done`);
  } else if (e.event === 'message') {
    messageChunks += 1;
    if (messageChunks % 50 === 0)
      console.log(`[${stamp()}] … ${messageChunks} message chunks`);
  } else if (e.event === 'reasoning') {
    reasoningChunks += 1;
  }
};

console.log(`[${stamp()}] sending (${prompt.length} chars)`);
const result = await client.stream(sessionId, prompt, { onEvent });
const secs = (result.durationMs / 1000).toFixed(1);
console.log(`\n=== finished: HTTP ${result.status} in ${secs}s`);
console.log(`request id: ${result.requestId}`);
console.log(
  `events: ${result.events.length} (message ${messageChunks}, reasoning ${reasoningChunks}, tool calls ${[...toolCounts].map(([n, c]) => `${n}×${c}`).join(', ') || 'none'})`,
);
console.log(
  `answer: ${result.text.length} chars, ~${result.text.split(/\s+/).length} words`,
);
console.log(
  `--- first 600 chars ---\n${result.text.slice(0, 600)}\n--- last 400 chars ---\n${result.text.slice(-400)}`,
);
const urls = new Set(result.text.match(/https?:\/\/[^\s)\]>]+/g) ?? []);
console.log(`distinct URLs cited: ${urls.size}`);

const storage = await authed('GET', '/debug/storage');
console.log(
  `\n/debug/storage: ${storage.status} ${storage.text.slice(0, 500)}`,
);
const errors = result.events.filter((e: SSEEvent) => e.event === 'error');
if (errors.length || result.status !== 200) process.exitCode = 1;
