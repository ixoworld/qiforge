#!/usr/bin/env node
/**
 * Minimal Codex App Server stand-in: speaks the real newline-delimited
 * JSON-RPC framing over stdio so the transport, client, approval round-trip
 * and event mapping are exercised against a real process rather than a stub.
 *
 * Scenarios are selected with CLI flags rather than environment variables so
 * a test never has to mutate global state to steer the server:
 *
 *   --account=none            `account/read` reports no signed-in account
 *   --require-login           mirror the real server: no account until
 *                             `account/login/start` registers a key
 *   --require-approval        ask for command approval mid-turn
 *   --exit-on-turn            exit mid-turn, every turn
 *   --exit-on-turn-once=FILE  exit mid-turn unless FILE exists, creating it on
 *                             the way out — so the next spawn behaves normally
 *                             and a reconnect can be observed
 */
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagValue = (name) => {
  const match = argv.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : undefined;
};

const noAccount = flagValue('--account') === 'none';
const requireLogin = hasFlag('--require-login');
let loggedIn = false;
const requireApproval = hasFlag('--require-approval');
const exitOnEveryTurn = hasFlag('--exit-on-turn');
const exitOnceMarker = flagValue('--exit-on-turn-once');

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

let turnCounter = 0;
let threadCounter = 0;
const approvals = new Map();

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }

  // A response to one of our own server→client requests (an approval).
  if (frame.id !== undefined && frame.method === undefined) {
    const pending = approvals.get(frame.id);
    if (pending) {
      approvals.delete(frame.id);
      pending(frame.result?.decision ?? 'decline');
    }
    return;
  }

  handle(frame);
});

function handle({ id, method, params }) {
  switch (method) {
    case 'initialize':
      send({
        id,
        result: { userAgent: 'fake-codex/1.0', platformFamily: 'test' },
      });
      return;

    case 'initialized':
      return;

    case 'account/read': {
      // The real App Server does not read OPENAI_API_KEY from its environment
      // for account purposes — a key has to be registered through
      // `account/login/start` first.
      const signedIn = !noAccount && (!requireLogin || loggedIn);
      send({
        id,
        result: signedIn
          ? {
              account: { type: 'apiKey', planType: 'pro' },
              requiresOpenaiAuth: false,
            }
          : { account: null, requiresOpenaiAuth: true },
      });
      return;
    }

    case 'account/login/start':
      if (params?.type !== 'apiKey' || !params?.apiKey) {
        send({ id, error: { code: -32600, message: 'Invalid request' } });
        return;
      }
      loggedIn = true;
      send({ id, result: { type: 'apiKey' } });
      return;

    case 'thread/start':
      threadCounter += 1;
      send({ id, result: { thread: { id: `thr_${threadCounter}` } } });
      return;

    case 'thread/resume':
      if (params?.threadId === 'thr_missing') {
        send({ id, error: { code: -32000, message: 'unknown thread' } });
        return;
      }
      send({ id, result: { thread: { id: params.threadId } } });
      return;

    case 'turn/start':
      void runTurn(id, params);
      return;

    case 'turn/interrupt':
      send({ id, result: {} });
      return;

    default:
      send({ id, error: { code: -32601, message: `unknown: ${method}` } });
  }
}

/** True when this process should die mid-turn to exercise reconnect. */
function shouldExitMidTurn() {
  if (exitOnEveryTurn) return true;
  if (!exitOnceMarker) return false;
  if (existsSync(exitOnceMarker)) return false;
  writeFileSync(exitOnceMarker, 'crashed');
  return true;
}

async function runTurn(id, params) {
  turnCounter += 1;
  const turnId = `turn_${turnCounter}`;
  const { threadId } = params;

  send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
  send({ method: 'turn/started', params: { turn: { id: turnId } } });

  if (shouldExitMidTurn()) {
    process.exit(3);
  }

  send({
    method: 'item/reasoning/textDelta',
    params: { itemId: 'r1', delta: 'planning' },
  });

  if (requireApproval) {
    const decision = await requestApproval(threadId, turnId);
    if (decision !== 'accept' && decision !== 'acceptForSession') {
      send({
        method: 'item/completed',
        params: {
          item: {
            id: 'm1',
            type: 'agentMessage',
            text: `declined: ${decision}`,
          },
        },
      });
      send({
        method: 'turn/completed',
        params: { turn: { id: turnId, status: 'completed' } },
      });
      return;
    }
    send({
      method: 'item/completed',
      params: {
        item: { id: 'c1', type: 'commandExecution', text: 'exit 0' },
      },
    });
  }

  send({
    method: 'item/agentMessage/delta',
    params: { itemId: 'm1', delta: 'partial' },
  });
  send({
    method: 'item/completed',
    params: {
      item: {
        id: 'm1',
        type: 'agentMessage',
        text: `handled: ${params.input?.[0]?.text ?? ''}`,
      },
    },
  });
  send({
    method: 'turn/completed',
    // The real server includes an explicit `error: null` on success.
    params: { turn: { id: turnId, status: 'completed', error: null } },
  });
}

function requestApproval(threadId, turnId) {
  const approvalRpcId = 9000 + approvals.size;
  return new Promise((resolve) => {
    approvals.set(approvalRpcId, resolve);
    send({
      id: approvalRpcId,
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'c1',
        threadId,
        turnId,
        command: 'rm -rf build',
        cwd: '/workspace',
      },
    });
  });
}
