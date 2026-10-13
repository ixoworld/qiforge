/**
 * Write tools end to end against an in-memory homeserver (test-homeserver.ts):
 * the real provider, matrix-crdt and the editor's compiler, with every
 * request counted.
 */
import { describe, expect, it } from 'vitest';
import type * as Y from 'yjs';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import { readFlowSpec } from './read';
import {
  TEST_HOMESERVER_URL,
  TEST_ORACLE_USER,
  TestHomeserver,
  watchUnhandledRejections,
} from './test-homeserver';
import { hydrateFlowDoc, setStepRuntime, someActionType } from './test-support';
import { buildAuthoringTools } from './tools/authoring';
import { buildSettingsTools } from './tools/settings';
import { ToolMessage } from '@langchain/core/messages';
import { uncertainResultReason } from '../../core/middlewares/tool-execution';
import type { SendOutcome } from './test-homeserver';
import { flowSpecToBaseUcan } from './translator';

const OWNER = 'did:ixo:ixo1owner';
const ASSIGNEE = 'did:ixo:ixo1assignee';
let roomCounter = 0;

/** A unique room per test: the membership cache is module-wide. */
function nextRoom(): string {
  roomCounter += 1;
  return `!authoring-${roomCounter}-${crypto.randomUUID().slice(0, 6)}:test.example`;
}

function flowsContext(abortSignal?: AbortSignal): RuntimeContext {
  const base = makeRuntimeContext(abortSignal ? { abortSignal } : {});
  return {
    ...base,
    matrix: {
      ...base.matrix,
      getRoomState: async (roomId: string) => ({
        roomId,
        state: [
          {
            type: 'm.room.member',
            state_key: base.user.matrixUserId,
            content: { membership: 'join' },
          },
        ],
      }),
      botCredentials: async () => ({
        baseUrl: TEST_HOMESERVER_URL,
        userId: TEST_ORACLE_USER,
        accessToken: 'test-token',
        deviceId: 'TESTDEVICE',
      }),
    },
  };
}

function seedFlow(hs: TestHomeserver, roomId: string, title = 'T'): Y.Doc {
  const action = someActionType();
  const doc = hydrateFlowDoc(
    flowSpecToBaseUcan(
      {
        title,
        steps: [
          { id: 'a', action, inputs: { x: 'a-value' } },
          { id: 'b', action },
          { id: 'c', action },
        ],
      },
      { flowId: 'seeded-flow', ownerDid: OWNER },
    ),
  );
  hs.seedDoc(roomId, doc);
  return doc;
}

function toolsFor(hs: TestHomeserver): Map<string, PluginTool> {
  const client = hs.client();
  return new Map(
    [...buildAuthoringTools(client), ...buildSettingsTools(client)].map((t) => [
      t.name,
      t,
    ]),
  );
}

async function call(
  tools: Map<string, PluginTool>,
  name: string,
  args: Record<string, unknown>,
  ctx = flowsContext(),
): Promise<unknown> {
  const found = tools.get(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.handler(args, ctx);
}

function updateSends(hs: TestHomeserver): number {
  return hs.count('PUT', '/send/matrix-crdt.doc_update');
}

describe('create_template', () => {
  it('refuses a room that already holds a flow and changes nothing', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    const seeded = hs.docOf(roomId);
    setStepRuntime(seeded, 'a', { state: 'completed' });
    hs.seedDoc(roomId, seeded);
    const tools = toolsFor(hs);

    const result = await call(tools, 'create_template', {
      flow: {
        ref: roomId,
        title: 'New',
        steps: [{ id: 'z', action: someActionType() }],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(updateSends(hs)).toBe(0);
    const after = hs.docOf(roomId);
    expect(readFlowSpec(after, roomId)?.steps.map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(after.getMap('runtime').get('flow_block_a')).toMatchObject({
      state: 'completed',
    });
    expect(hs.openPolls).toBe(0);
  });

  it('authors a new flow with one load for every post-compile pass', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    const tools = toolsFor(hs);
    const action = someActionType();

    const result = await call(tools, 'create_template', {
      flow: {
        ref: roomId,
        title: 'Fresh',
        steps: [
          { id: 'one', action, inputs: { x: '1' } },
          {
            id: 'two',
            action,
            assignTo: ASSIGNEE,
            execution: 'human-only',
            runWhen: {
              source: 'configured_input',
              fromStep: 'one',
              field: 'x',
              is: 'equals',
              value: '1',
            },
          },
        ],
      },
    });

    expect(result).toEqual({ ok: true, flowRef: roomId });
    // Pre-check, compile, and one post-compile load.
    expect(hs.count('GET', '/messages')).toBe(3);
    const flow = readFlowSpec(hs.docOf(roomId), roomId);
    expect(flow?.title).toBe('Fresh');
    const two = flow?.steps.find((s) => s.id === 'two');
    expect(two).toMatchObject({
      assignTo: ASSIGNEE,
      execution: 'human-only',
      runWhen: { fromStep: 'one', field: 'x', is: 'equals' },
    });
    expect(hs.openPolls).toBe(0);
  });
});

describe('add_step', () => {
  it('keeps the title, owner and earlier order, and loads the flow three times', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId, 'Kept title');
    const tools = toolsFor(hs);

    expect(
      await call(tools, 'reorder_step', {
        flowRef: roomId,
        stepId: 'c',
        toIndex: 0,
      }),
    ).toEqual({ ok: true });
    const loadsBefore = hs.count('GET', '/messages');

    const result = await call(tools, 'add_step', {
      flowRef: roomId,
      step: {
        id: 'd',
        action: someActionType(),
        assignTo: ASSIGNEE,
        execution: 'agent-capable',
        skills: ['skill-x'],
        runWhen: {
          source: 'runtime_output',
          fromStep: 'a',
          field: 'value',
          is: 'isNotEmpty',
        },
      },
      position: { after: 'a' },
    });

    expect(result).toEqual({ ok: true });
    expect(hs.count('GET', '/messages') - loadsBefore).toBe(3);
    const doc = hs.docOf(roomId);
    const meta = doc.getMap('qi.flow.meta');
    expect(meta.get('title')).toBe('Kept title');
    expect(meta.get('flowOwnerDid')).toBe(OWNER);
    expect(doc.getArray('qi.flow.order').toArray()).toEqual([
      'c',
      'a',
      'd',
      'b',
    ]);
    const added = readFlowSpec(doc, roomId)?.steps.find((s) => s.id === 'd');
    expect(added).toMatchObject({
      assignTo: ASSIGNEE,
      execution: 'agent-capable',
      skills: ['skill-x'],
      runWhen: { fromStep: 'a', is: 'isNotEmpty' },
    });
    expect(hs.openPolls).toBe(0);
  });

  it('refuses a duplicate step id and writes nothing', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    const tools = toolsFor(hs);

    const result = await call(tools, 'add_step', {
      flowRef: roomId,
      step: { id: 'b', action: someActionType(), assignTo: ASSIGNEE },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(updateSends(hs)).toBe(0);
    const b = readFlowSpec(hs.docOf(roomId), roomId)?.steps.find(
      (s) => s.id === 'b',
    );
    expect(b?.assignTo).toBeUndefined();
  });
});

describe('validation before the first change', () => {
  it('a failing update_step leaves the step unchanged and writes nothing', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    const tools = toolsFor(hs);

    const result = await call(tools, 'update_step', {
      flowRef: roomId,
      stepId: 'a',
      patch: {
        inputs: { x: 'changed' },
        conditions: [
          {
            source: 'runtime_output',
            fromStep: 'typo',
            field: 'x',
            is: 'isEmpty',
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'step_not_found' },
    });
    expect(updateSends(hs)).toBe(0);
    expect(
      readFlowSpec(hs.docOf(roomId), roomId)?.steps.find((s) => s.id === 'a')
        ?.inputs,
    ).toEqual({ x: 'a-value' });
  });

  it('a failing add_step leaves no step behind', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    const tools = toolsFor(hs);

    const result = await call(tools, 'add_step', {
      flowRef: roomId,
      step: {
        id: 'd',
        action: someActionType(),
        runWhen: {
          source: 'runtime_output',
          fromStep: 'ghost',
          field: 'x',
          is: 'isEmpty',
        },
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(updateSends(hs)).toBe(0);
    const doc = hs.docOf(roomId);
    expect(doc.getArray('qi.flow.order').toArray()).toEqual(['a', 'b', 'c']);
    expect(doc.getMap('qi.flow.nodes').has('d')).toBe(false);
  });

  it('add_step refuses a secret referring to a step the flow does not have', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);

    const result = await call(toolsFor(hs), 'add_step', {
      flowRef: roomId,
      step: {
        id: 'd',
        action: someActionType(),
        inputs: { pin: '{{ghost.output.pin}}' },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(updateSends(hs)).toBe(0);
  });
});

describe('write outcome', () => {
  it('reports needs_access when the homeserver forbids the write', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    hs.sendScript = [{ status: 403, errcode: 'M_FORBIDDEN' }];
    const tools = toolsFor(hs);

    const result = await call(tools, 'set_step_inputs', {
      flowRef: roomId,
      stepId: 'a',
      inputs: { x: 'changed' },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'needs_access' },
    });
    expect(updateSends(hs)).toBe(1);
  });

  it('fails within a bounded time and number of sends when the homeserver keeps failing', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    hs.sendScript = Array.from({ length: 100 }, () => ({
      status: 500,
      errcode: 'M_UNKNOWN',
    }));
    const tools = toolsFor(hs);

    const started = Date.now();
    const result = await call(tools, 'set_step_inputs', {
      flowRef: roomId,
      stepId: 'a',
      inputs: { x: 'changed' },
    });

    // A 5xx answer may follow a stored event: the outcome is unknown.
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'write_not_saved',
        message: expect.stringMatching(/may or may not have been saved/),
      },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    const sends = updateSends(hs);
    expect(sends).toBe(4);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(updateSends(hs)).toBe(sends);
    expect(hs.openPolls).toBe(0);
  });

  async function setInputsWith(script: SendOutcome[]): Promise<unknown> {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    hs.sendScript = script;
    return call(toolsFor(hs), 'set_step_inputs', {
      flowRef: roomId,
      stepId: 'a',
      inputs: { x: 'changed' },
    });
  }
  const repeat = (outcome: SendOutcome, times = 10): SendOutcome[] =>
    Array.from({ length: times }, () => outcome);

  it('reports write_not_saved when every send fails without an HTTP answer', async () => {
    expect(await setInputsWith(repeat('network'))).toMatchObject({
      ok: false,
      error: { code: 'write_not_saved' },
    });
  });

  it('reports write_not_saved when a server error precedes a client error', async () => {
    expect(
      await setInputsWith([
        { status: 502, errcode: 'M_UNKNOWN' },
        { status: 413, errcode: 'M_TOO_LARGE' },
      ]),
    ).toMatchObject({ ok: false, error: { code: 'write_not_saved' } });
  });

  it.each([
    [413, 'M_TOO_LARGE'],
    [400, 'M_BAD_JSON'],
    [401, 'M_UNKNOWN_TOKEN'],
  ])(
    'reports a plain error (nothing was written) for a %i refusal',
    async (status, errcode) => {
      expect(await setInputsWith([{ status, errcode }])).toMatchObject({
        ok: false,
        error: {
          code: 'error',
          message: expect.stringMatching(/refused the change/),
        },
      });
    },
  );

  it('reports write_not_saved when the send is never answered within the flush budget', async () => {
    const started = Date.now();
    expect(await setInputsWith(['hang'])).toMatchObject({
      ok: false,
      error: { code: 'write_not_saved' },
    });
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 45_000);

  it('reports write_not_saved from the compile path (create_template)', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    hs.sendScript = repeat({ status: 500, errcode: 'M_UNKNOWN' }, 50);
    const result = await call(toolsFor(hs), 'create_template', {
      flow: {
        ref: roomId,
        title: 'Fresh',
        steps: [{ id: 'one', action: someActionType() }],
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'write_not_saved' },
    });
  });

  it("is one of the runtime's uncertain-outcome codes, so the write's claim is kept", async () => {
    const result = await setInputsWith(
      repeat({ status: 500, errcode: 'M_UNKNOWN' }),
    );
    const message = new ToolMessage({
      content: JSON.stringify(result),
      tool_call_id: 'call-1',
    });
    expect(uncertainResultReason(message)).not.toBeNull();
    // A refusal that wrote nothing stays a known outcome.
    const refused = await setInputsWith([
      { status: 413, errcode: 'M_TOO_LARGE' },
    ]);
    expect(
      uncertainResultReason(
        new ToolMessage({
          content: JSON.stringify(refused),
          tool_call_id: 'call-2',
        }),
      ),
    ).toBeNull();
  });

  it('refuses a recovery phrase or a secret wrapped in braces without writing', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    const tools = toolsFor(hs);

    for (const inputs of [
      { matrixRecoveryPhrase: 'abandon ability able about above absent' },
      { pin: '{{1234}}' },
      { pin: '{{ghost.output.pin}}' },
    ]) {
      expect(
        await call(tools, 'set_step_inputs', {
          flowRef: roomId,
          stepId: 'b',
          inputs,
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    }
    expect(updateSends(hs)).toBe(0);
  });

  it('refuses a literal PIN without writing, and accepts a reference', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    const tools = toolsFor(hs);

    const refused = await call(tools, 'set_step_inputs', {
      flowRef: roomId,
      stepId: 'b',
      inputs: { pin: '1234' },
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(updateSends(hs)).toBe(0);

    const accepted = await call(tools, 'set_step_inputs', {
      flowRef: roomId,
      stepId: 'b',
      inputs: { pin: '{{a.output.pin}}' },
    });
    expect(accepted).toEqual({ ok: true });
  });

  it('rejects an assignee that is not a DID', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    const tools = toolsFor(hs);

    const result = await call(tools, 'set_step_assignment', {
      flowRef: roomId,
      stepId: 'a',
      assignTo: 'alice',
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(updateSends(hs)).toBe(0);
  });

  it('disposes the document when the request is aborted during the history walk', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    hs.messagesDelays = [300];
    const tools = toolsFor(hs);
    const controller = new AbortController();
    const rejections = watchUnhandledRejections();

    const pending = call(
      tools,
      'set_step_inputs',
      { flowRef: roomId, stepId: 'a', inputs: { x: 'changed' } },
      flowsContext(controller.signal),
    );
    // Abort once the load is under way (the /messages answer is held).
    while (hs.count('GET', '/messages') === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error('cancelled'));

    expect(await pending).toMatchObject({ ok: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(updateSends(hs)).toBe(0);
    expect(hs.openPolls).toBe(0);
    rejections.stop();
    expect(rejections.reasons).toEqual([]);
  });

  it('disposes the document when the request is aborted mid-load', async () => {
    const hs = new TestHomeserver();
    const roomId = nextRoom();
    seedFlow(hs, roomId);
    const tools = toolsFor(hs);
    const controller = new AbortController();
    const rejections = watchUnhandledRejections();

    const pending = call(
      tools,
      'set_step_inputs',
      { flowRef: roomId, stepId: 'a', inputs: { x: 'changed' } },
      flowsContext(controller.signal),
    );
    controller.abort(new Error('cancelled'));

    expect(await pending).toMatchObject({ ok: false });
    expect(updateSends(hs)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hs.openPolls).toBe(0);
    rejections.stop();
    expect(rejections.reasons).toEqual([]);
  });
});
