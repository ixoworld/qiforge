// ChatGPT-subscription BYO end to end on the devnet worker: device flow (the
// owner approves the code in a browser), then a JSON and a streaming turn.
//   MODE=start  → prints verificationUri + userCode, saves the device auth id
//   MODE=finish → polls until connected, runs the turns, leaves the account connected
//   MODE=disconnect → DELETE the credential
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { mintAuthInvocation, type HarnessAccount } from '../lib/harness';
const SP = fileURLToPath(new URL('../.devnet-accounts', import.meta.url));
const URL_ = 'https://mike-devnet-oracle.ixo-api.workers.dev';
const MODE = process.env.MODE ?? 'start';
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
  900,
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
if (MODE === 'start') {
  const s = await call('POST', '/byo-llm/chatgpt/device/start');
  console.log('start:', s.status, s.text.slice(0, 300));
  const d = JSON.parse(s.text);
  writeFileSync(`${SP}/chatgpt-device-auth.json`, JSON.stringify(d));
  console.log(
    `\n>>> OPEN ${d.verificationUri}  and enter the code  ${d.userCode}  (expires in ${d.expiresIn}s)\n`,
  );
} else if (MODE === 'finish') {
  const d = JSON.parse(readFileSync(`${SP}/chatgpt-device-auth.json`, 'utf8'));
  let connected = false;
  for (let i = 0; i < 60 && !connected; i++) {
    const p = await call('POST', '/byo-llm/chatgpt/device/poll', {
      deviceAuthId: d.deviceAuthId,
      userCode: d.userCode,
    });
    const j = JSON.parse(p.text);
    if (j.status === 'connected') {
      connected = true;
      console.log('connected; default model', j.defaultModelId);
      break;
    }
    if (j.status === 'failed') {
      console.log('failed:', j.error);
      process.exit(1);
    }
    await sleep((d.interval ?? 5) * 1000);
  }
  if (!connected) {
    console.log('not approved in time');
    process.exit(1);
  }
  const st = JSON.parse((await call('GET', '/byo-llm/status')).text);
  const cg = st.providers.find(
    (p: { provider: string }) => p.provider === 'chatgpt',
  );
  const model = cg.defaultModelId ?? cg.models[0]?.id;
  console.log(
    'chatgpt models:',
    cg.models.map((m: { id: string }) => m.id).join(', '),
    '→ using',
    model,
  );
  const s = await call('POST', '/sessions', {});
  const sid = JSON.parse(s.text).sessionId ?? JSON.parse(s.text).id;
  console.log('session', s.status, sid);
  let t0 = Date.now();
  const turn = await call('POST', `/messages/${sid}`, {
    message: 'Reply with exactly: PONG via subscription.',
    model,
    stream: false,
  });
  console.log(
    `JSON turn: ${turn.status} in ${Date.now() - t0} ms → ${turn.text.slice(0, 300).replace(/\s+/g, ' ')}`,
  );
  t0 = Date.now();
  const res = await fetch(URL_ + `/messages/${sid}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      message: 'Count from 1 to 12 as words, one per line.',
      model,
      stream: true,
    }),
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const chunkTimes: number[] = [];
  let events = 0;
  let errors = 0;
  let final = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunkTimes.push(Date.now() - t0);
    const s2 = dec.decode(value, { stream: true });
    buf += s2;
    events += (s2.match(/^event: /gm) ?? []).length;
    if (/^event: error/m.test(s2)) errors++;
  }
  const datas = [...buf.matchAll(/^data: (\{.*\})$/gm)]
    .map((m) => {
      try {
        return JSON.parse(m[1]!);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as any[];
  final =
    datas
      .map((x) => x.content ?? x.message?.content)
      .filter((c) => typeof c === 'string')
      .pop() ?? '';
  console.log(
    `stream: ${res.status}, ${chunkTimes.length} chunks over ${Date.now() - t0} ms (first ${chunkTimes[0]} ms, last ${chunkTimes.at(-1)} ms), ${events} events, ${errors} errors; final: ${final.replace(/\s+/g, ' ').slice(0, 160)}`,
  );
} else if (MODE === 'turn') {
  const st = JSON.parse((await call('GET', '/byo-llm/status')).text);
  const cg = st.providers.find(
    (p: { provider: string }) => p.provider === 'chatgpt',
  );
  console.log('chatgpt connected:', cg.connected);
  const model = cg.defaultModelId;
  const s = await call('POST', '/sessions', {});
  const sid = JSON.parse(s.text).sessionId ?? JSON.parse(s.text).id;
  const t0 = Date.now();
  const turn = await call('POST', `/messages/${sid}`, {
    message: 'Reply with exactly: PONG again via subscription.',
    model,
    stream: false,
  });
  console.log(
    `JSON turn: ${turn.status} in ${Date.now() - t0} ms → ${turn.text.slice(0, 220).replace(/\s+/g, ' ')}`,
  );
} else if (MODE === 'disconnect') {
  console.log(
    'DELETE:',
    (await call('DELETE', '/byo-llm/credentials/chatgpt')).status,
  );
}
