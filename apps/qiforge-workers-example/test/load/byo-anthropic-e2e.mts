import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { mintAuthInvocation, type HarnessAccount } from '../lib/harness';
const SP = fileURLToPath(new URL('../.devnet-accounts', import.meta.url));
const URL_ = 'https://mike-devnet-oracle.ixo-api.workers.dev';
const KEY = process.env.BYO_TEST_KEY!;
if (!KEY) throw new Error('BYO_TEST_KEY missing');
const a = JSON.parse(readFileSync(`${SP}/devnet-user-2.json`, 'utf8'));
const acct: HarnessAccount = {
  name: 'u2',
  address: a.address,
  did: a.did,
  edSigningMnemonic: a.edSigningMnemonic,
  matrixUserId: a.matrixUserId,
  matrixPassword: a.matrixPassword,
  matrixMnemonic: '',
};
const inv = await mintAuthInvocation(
  acct,
  'did:ixo:ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3',
  600,
);
const H = {
  Authorization: `Bearer ${inv}`,
  'X-Auth-Type': 'ucan',
  'Content-Type': 'application/json',
};
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(URL_ + path, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, text: await r.text() };
};
const show = (label: string, r: { status: number; text: string }) =>
  console.log(
    `${label}: ${r.status} ${r.text.slice(0, 260).replace(/\s+/g, ' ')}`,
  );
show(
  'PUT anthropic',
  await call('PUT', '/byo-llm/credentials/anthropic', { apiKey: KEY }),
);
show('POST validate', await call('POST', '/byo-llm/validate/anthropic'));
const st = JSON.parse((await call('GET', '/byo-llm/status')).text);
const an = st.providers.find(
  (p: { provider: string }) => p.provider === 'anthropic',
);
const modelIds: string[] = (an.models ?? []).map((m: { id: string }) => m.id);
console.log(
  'anthropic connected:',
  an.connected,
  'models:',
  modelIds.join(', '),
  'default:',
  an.defaultModelId,
);
const model = an.defaultModelId ?? modelIds[0];
const s = await call('POST', '/sessions', {});
const sid = JSON.parse(s.text).sessionId ?? JSON.parse(s.text).id;
console.log('session', s.status, sid);
let t0 = Date.now();
const turn = await call('POST', `/messages/${sid}`, {
  message:
    'Reply with exactly: PONG from <the name of the company that trained you>. Nothing else.',
  model,
  stream: false,
});
console.log(
  `JSON turn (${model}): ${turn.status} in ${Date.now() - t0} ms → ${turn.text.slice(0, 300).replace(/\s+/g, ' ')}`,
);
t0 = Date.now();
const stream = await fetch(URL_ + `/messages/${sid}`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    message:
      'Now reply with exactly: PING again, and name your model family in three words.',
    model,
    stream: true,
  }),
});
const text = await stream.text();
const kinds = [
  ...new Set([...text.matchAll(/^event: (\S+)/gm)].map((m) => m[1])),
];
const content = [...text.matchAll(/^data: (\{.*\})$/gm)]
  .map((m) => {
    try {
      return JSON.parse(m[1]!);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const finalMsg = content
  .filter((d: any) => d?.content || d?.message)
  .map((d: any) => d.content ?? d.message?.content)
  .filter((c) => typeof c === 'string')
  .pop();
console.log(
  `stream turn: ${stream.status} in ${Date.now() - t0} ms; events: ${kinds.join(',')}; errors: ${content.filter((d: any) => d?.error).length}; final: ${String(finalMsg ?? '').slice(0, 200)}`,
);
const tr = await call('GET', `/messages/${sid}`);
console.log('transcript entries:', (JSON.parse(tr.text) as unknown[]).length);
show(
  'DELETE anthropic',
  await call('DELETE', '/byo-llm/credentials/anthropic'),
);
const st2 = JSON.parse((await call('GET', '/byo-llm/status')).text);
console.log(
  'anthropic connected after delete:',
  st2.providers.find((p: { provider: string }) => p.provider === 'anthropic')
    .connected,
);
