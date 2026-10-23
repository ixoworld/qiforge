/**
 * Paid-service loop on devnet, through a running Workers oracle: the buyer
 * chats, the oracle quotes in support mode, opens a paid job (escrow intent on
 * chain), does the work in work mode and delivers it as a claim on chain.
 *
 *   ORACLE_URL=http://localhost:8787 ORACLE_DID=did:ixo:ixo1… \
 *   ACCOUNT_JSON=<buyer harness account> COLLECTION_ID=<buyer's collection> \
 *   tsx test/e2e-payments.ts
 *
 * Prerequisites (one-off, devnet): the buyer's collection grants the oracle a
 * `SubmitClaimAuthorization`, its payment account holds the escrow, its deed
 * room has the claim bot, and decision-engine holds the buyer's
 * `agent-services/v1` agreement for the oracle's address. The oracle runs with
 * `ORACLE_SECP_MNEMONIC`, `SEQUENCE_MANAGER` and `AGENT_CARD_JSON`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChatClient } from './lib/chat-client';
import {
  mintAuthInvocation,
  mintDelegation,
  type HarnessAccount,
} from './lib/harness';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const ORACLE_URL = need('ORACLE_URL');
const ORACLE_DID = need('ORACLE_DID');
const COLLECTION_ID = need('COLLECTION_ID');
const buyer: HarnessAccount = JSON.parse(
  readFileSync(need('ACCOUNT_JSON'), 'utf8'),
);

/** The transcript DTO: tool results ride on the AI message's `toolCalls[].output`. */
interface TurnMessage {
  type: string;
  content: string;
  toolCalls?: Array<{ name: string; args?: unknown; output?: string }>;
}

function messagesOf(body: Record<string, unknown>): TurnMessage[] {
  const all = body.messages;
  return Array.isArray(all) ? all : [];
}

const toolCalls = (msgs: TurnMessage[]) =>
  msgs.flatMap((m) => (m.toolCalls ?? []).map((c) => c.name));
const toolResult = (msgs: TurnMessage[], name: string) =>
  msgs
    .flatMap((m) => m.toolCalls ?? [])
    .filter((c) => c.name === name)
    .map((c) => c.output ?? '')
    .join('\n');

async function turn(
  client: ChatClient,
  sessionId: string,
  text: string,
  sinceCount: number,
) {
  const res = await client.send(sessionId, text);
  assert.equal(
    res.status,
    200,
    `turn failed: ${JSON.stringify(res.body).slice(0, 400)}`,
  );
  const msgs = messagesOf(res.body).slice(sinceCount);
  console.log(
    `\n> ${text}\n  tools: ${toolCalls(msgs).join(', ') || '—'} (${res.durationMs} ms)`,
  );
  return { msgs, total: messagesOf(res.body).length };
}

const invocation = await mintAuthInvocation(buyer, ORACLE_DID);
const delegation = await mintDelegation(buyer, ORACLE_DID, [
  { can: 'memory/*', with: 'ixo:memory' },
]);
const client = new ChatClient(ORACLE_URL, { invocation, delegation });
const sessionId = await client.createSession();

// 1. Support mode: the front desk quotes and does not work.
let seen = 0;
const quote = await turn(
  client,
  sessionId,
  'Hi — what services do you offer, and what do they cost?',
  seen,
);
seen = quote.total;
assert.ok(
  toolCalls(quote.msgs).includes('list_services'),
  'support mode should look up the catalog',
);
assert.ok(
  !toolCalls(quote.msgs).includes('deliver_work'),
  'support mode must never deliver',
);

// 2. Hire → start_work: the gate passes and the escrow is reserved on chain.
const start = await turn(
  client,
  sessionId,
  "I've hired you for the MRV plan design (service id mrv-plan). Please start the job now — it's for a 40 ha mangrove restoration project in Lamu County, Kenya.",
  seen,
);
seen = start.total;
const started = toolResult(start.msgs, 'start_work');
console.log(`  start_work → ${started.slice(0, 300)}`);
assert.match(started, /Job started/, 'start_work should open the paid job');
const intentTx = /tx ([0-9A-F]{64})/.exec(started)?.[1];
assert.ok(intentTx, 'start_work should report the escrow tx');

// 3. Work mode: do the job and deliver it as a claim.
const work = await turn(
  client,
  sessionId,
  'Great. Please produce the full MRV plan now and deliver it when done — no need to ask me anything else.',
  seen,
);
let delivered = toolResult(work.msgs, 'deliver_work');
if (!delivered) {
  const nudge = await turn(
    client,
    sessionId,
    'Please deliver it now with deliver_work.',
    work.total,
  );
  delivered = toolResult(nudge.msgs, 'deliver_work');
}
console.log(`  deliver_work → ${delivered.slice(0, 300)}`);
assert.match(
  delivered,
  /Delivered\. The work claim (\S+) is on chain \(tx ([0-9A-F]{64})\)/,
);
const [, claimId, claimTx] =
  /The work claim (\S+) is on chain \(tx ([0-9A-F]{64})\)/.exec(delivered) ??
  [];

// 4. Chain: the claim exists on the buyer's collection, as this oracle, backed by the escrow.
const BLOCKSYNC =
  process.env.BLOCKSYNC_GRAPHQL_URL ??
  'https://devnet-blocksync-graphql.ixo.earth/graphql';
interface IndexedClaim {
  collectionId: string;
  agentDid: string;
  useIntent: boolean;
  paymentsStatus: { approval: string };
}
let indexed: IndexedClaim | undefined;
for (let i = 0; i < 20 && !indexed; i++) {
  const res = await fetch(BLOCKSYNC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `{ claims(filter:{claimId:{equalTo:"${claimId}"}}){ nodes { collectionId agentDid useIntent paymentsStatus } } }`,
    }),
  });
  const body: { data?: { claims?: { nodes?: IndexedClaim[] } } } =
    await res.json();
  indexed = body.data?.claims?.nodes?.[0];
  if (!indexed) await new Promise((r) => setTimeout(r, 3000));
}
console.log(`  indexed claim → ${JSON.stringify(indexed)}`);
assert.ok(indexed, `claim ${claimId} never appeared in Blocksync`);
assert.equal(indexed.collectionId, COLLECTION_ID);
assert.equal(indexed.agentDid, ORACLE_DID);
assert.equal(indexed.useIntent, true);
assert.equal(
  indexed.paymentsStatus.approval,
  'GUARANTEED',
  'the claim should be backed by the escrow',
);

console.log(
  `\nPASS — escrow tx ${intentTx}, claim ${claimId} (tx ${claimTx}) on collection ${COLLECTION_ID}`,
);
