#!/usr/bin/env node
/**
 * Minimal Codex App Server stand-in: speaks the real newline-delimited
 * JSON-RPC framing over stdio so the transport, client, approval round-trip
 * and event mapping are exercised against a real process rather than a stub.
 *
 * Behaviour is driven by env vars so one fixture covers every scenario:
 *   FAKE_CODEX_ACCOUNT=none      → `account/read` reports no signed-in account
 *   FAKE_CODEX_REQUIRE_APPROVAL=1 → asks for command approval mid-turn
 *   FAKE_CODEX_EXIT_ON_TURN=1     → exits mid-turn to exercise reconnect
 */
import { createInterface } from 'node:readline';

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

    case 'account/read':
      send({
        id,
        result:
          process.env.FAKE_CODEX_ACCOUNT === 'none'
            ? { account: null }
            : { account: { authMode: 'chatgpt', planType: 'pro' } },
      });
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

async function runTurn(id, params) {
  turnCounter += 1;
  const turnId = `turn_${turnCounter}`;
  const { threadId } = params;

  send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
  send({ method: 'turn/started', params: { turn: { id: turnId } } });

  if (process.env.FAKE_CODEX_EXIT_ON_TURN === '1') {
    process.exit(3);
  }

  send({
    method: 'item/reasoning/textDelta',
    params: { itemId: 'r1', delta: 'planning' },
  });

  if (process.env.FAKE_CODEX_REQUIRE_APPROVAL === '1') {
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
    params: { turn: { id: turnId, status: 'completed' } },
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
