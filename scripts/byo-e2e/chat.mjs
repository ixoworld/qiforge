// Send one chat message to the local oracle and print the SSE stream.
//
//   node chat.mjs --new --model byo:chatgpt/gpt-5.6-terra --message "hi"
//   node chat.mjs --session <id> --model <id> --message "..."
//   node chat.mjs --models          # list available model ids
//
// Prints the session id so follow-up messages can reuse the thread.
import { apiJson, createSession, sendMessage, summarize } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : (args[i + 1]?.startsWith('--') ? true : args[i + 1]) ?? true;
};

if (args.includes('--models')) {
  const [models, byo] = await Promise.all([
    apiJson('/models'),
    apiJson('/byo-llm/status'),
  ]);
  console.log('platform models:');
  for (const m of models.models ?? models) console.log(`  ${m.id}  (${m.badge ?? m.tier ?? ''})`);
  console.log('byo models (connected providers):');
  for (const p of byo.providers ?? []) {
    if (!p.connected) continue;
    for (const m of p.models) console.log(`  ${m.id}  (${m.badge})`);
  }
  process.exit(0);
}

const message = flag('message') ?? 'hi';
const model = flag('model');
let sessionId = flag('session');

if (!sessionId || args.includes('--new')) {
  sessionId = await createSession();
  console.log(`created session: ${sessionId}`);
}

console.log(`session=${sessionId} model=${model ?? '(default)'}`);
const startedAt = Date.now();
const result = await sendMessage({
  sessionId,
  message,
  model,
  onEvent: (name, data) => {
    if (name === 'reasoning' && data?.reasoning && !data.isComplete) {
      process.stdout.write(`\x1b[2m${data.reasoning}\x1b[0m`);
    }
    if (name === 'message' && data?.content) process.stdout.write(data.content);
    if (name === 'error') console.error('\n[error]', JSON.stringify(data).slice(0, 300));
  },
});
console.log(`\n(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
summarize(`session ${sessionId}`, result);
