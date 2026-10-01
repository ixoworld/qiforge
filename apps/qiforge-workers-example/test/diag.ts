import { ChatClient } from './lib/chat-client';
import {
  STATIC_ACCOUNTS,
  mintAuthInvocation,
  type HarnessAccount,
} from './lib/harness';
import { ORACLE_DID, provisionDevVars, startOracle } from './lib/oracle';

async function main() {
  await provisionDevVars();
  const oracle = await startOracle();
  const alice = STATIC_ACCOUNTS[1] as HarnessAccount;
  const client = new ChatClient(oracle.url, {
    invocation: await mintAuthInvocation(alice, ORACLE_DID),
  });
  const sessionId = await client.createSession();
  console.log('session', sessionId);
  const r1 = await client.send(
    sessionId,
    'My favourite colour is teal. Reply with just: noted',
  );
  console.log('r1', r1.status, JSON.stringify(r1.body).slice(0, 300));
  const r2 = await client.send(
    sessionId,
    'What is my favourite colour? Reply with just the colour.',
  );
  console.log('r2', r2.status, JSON.stringify(r2.body).slice(0, 300));
  const list = await client.listMessages(sessionId);
  console.log(
    'transcript',
    list.messages.map((m) => `${m.type}: ${m.content.slice(0, 60)}`),
  );
  const st = await fetch(`${oracle.url}/debug/storage`, {
    headers: client.headers(),
  });
  console.log('storage', await st.text());
  const logs = oracle.logs();
  console.log('--- worker logs (tail) ---');
  console.log(
    logs
      .split('\n')
      .filter((l) => /user-do|error|Error|warn/i.test(l))
      .slice(-40)
      .join('\n'),
  );
  await oracle.stop();
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
