// Shared plumbing for the BYO-LLM live E2E scripts: UCAN auth from the test
// mnemonic, authed fetch, and SSE chat streaming with event collection.
import 'dotenv/config';
import {
  createInvocation,
  serializeInvocation,
  signerFromMnemonic,
} from '@ixo/ucan';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';

export const API_URL = (
  process.env.BYO_E2E_API_URL ?? 'http://localhost:5678'
).replace(/\/$/, '');
export const ORACLE_DID = process.env.BYO_E2E_ORACLE_DID ?? '';
const MNEMONIC = process.env.BYO_E2E_MNEMONIC ?? '';

if (!MNEMONIC || !ORACLE_DID) {
  console.error('BYO_E2E_MNEMONIC and BYO_E2E_ORACLE_DID must be set (.env)');
  process.exit(1);
}

let cachedDid;
export async function userDid() {
  if (!cachedDid) {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, {
      prefix: 'ixo',
    });
    const [account] = await wallet.getAccounts();
    cachedDid = `did:ixo:${account.address}`;
  }
  return cachedDid;
}

// The oracle caps auth-invocation TTLs at 900s — stay under it.
const TOKEN_TTL_SECONDS = 600;
let cachedToken;
let cachedTokenExpiry = 0;

export async function mintToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExpiry - 60) return cachedToken;
  const did = await userDid();
  const { signer } = await signerFromMnemonic(MNEMONIC, did);
  const invocation = await createInvocation({
    issuer: signer,
    audience: ORACLE_DID,
    capability: { can: '*', with: 'ixo:oracle' },
    expiration: now + TOKEN_TTL_SECONDS,
  });
  cachedToken = await serializeInvocation(invocation);
  cachedTokenExpiry = now + TOKEN_TTL_SECONDS;
  return cachedToken;
}

export async function api(path, init = {}) {
  const token = await mintToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Auth-Type': 'ucan',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  return res;
}

export async function apiJson(path, init = {}) {
  const res = await api(path, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function createSession() {
  const created = await apiJson('/sessions', { method: 'POST', body: '{}' });
  return created.sessionId ?? created.id ?? created;
}

/**
 * Send one chat message over SSE and collect the stream:
 *   { reasoning, text, events, errors, done }
 * `onEvent(name, data)` fires live for progress printing.
 */
export async function sendMessage({ sessionId, message, model, onEvent }) {
  const res = await api(`/messages/${sessionId}`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      stream: true,
      ...(model ? { model } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`POST /messages/${sessionId} -> ${res.status}: ${text.slice(0, 400)}`);
  }

  const result = {
    reasoning: '',
    text: '',
    events: [],
    errors: [],
    done: false,
  };
  const decoder = new TextDecoder();
  let buffer = '';

  const handleFrame = (frame) => {
    const eventMatch = /^event: (.+)$/m.exec(frame);
    const dataMatch = /^data: (.+)$/m.exec(frame);
    if (!eventMatch) return;
    const name = eventMatch[1];
    let data;
    if (dataMatch) {
      try {
        data = JSON.parse(dataMatch[1]);
      } catch {
        data = dataMatch[1];
      }
    }
    result.events.push(name);
    if (name === 'message' && data?.content) result.text += data.content;
    if (name === 'reasoning' && data?.reasoning && !data.isComplete) {
      result.reasoning += data.reasoning;
    }
    if (name === 'error') result.errors.push(data);
    if (name === 'done') result.done = true;
    onEvent?.(name, data);
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim() && !frame.startsWith(':')) handleFrame(frame);
    }
  }
  if (buffer.trim() && !buffer.startsWith(':')) handleFrame(buffer);
  return result;
}

export function summarize(label, result) {
  const eventCounts = result.events.reduce((acc, name) => {
    acc[name] = (acc[name] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n=== ${label}`);
  console.log(`events: ${JSON.stringify(eventCounts)}`);
  console.log(`reasoning chars: ${result.reasoning.length}`);
  console.log(`text: ${result.text.slice(0, 300)}${result.text.length > 300 ? '…' : ''}`);
  if (result.errors.length > 0) {
    console.log(`ERRORS: ${JSON.stringify(result.errors).slice(0, 500)}`);
  }
}
