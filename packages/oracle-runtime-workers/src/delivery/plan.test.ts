import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { convertMessagesToCompletionsMessageParams } from '@langchain/openai';
import { describe, expect, it, vi } from 'vitest';
import {
  carriedCallsOfTurn,
  SUMMARY_PREFIX,
  turnCarryKwargs,
} from '../core/middlewares/turn-boundary';
import { _default, stringify } from '../sqlite/serialization';
import { ATTACHMENT_VIEW_SOURCE } from '../attachments/retention';
import { HUB_ACTION_CARD_NOTE } from '../plugins/hub-actions/hub-actions.plugin';
import { resolveDeliveryProfile } from './profile';
import {
  draftReplyPlan,
  FAILED_RUN_NOTICE,
  failedRunFiles,
  isNarration,
  materializeReplyPlan,
  turnSteps,
  type DraftPart,
} from './plan';
import {
  parseReplyPlan,
  planText,
  planTextForModel,
  REPLY_FILE_URL_MAX,
} from './schema';
import type { ArtifactRef, ChatLimits, ReplyFile, ReplyPlan } from './types';

function limits(overrides: Partial<ChatLimits> = {}): ChatLimits {
  const profile = resolveDeliveryProfile({
    client: 'channel',
    channel: {
      provider: 'whatsapp',
      bindingId: 'chb_x',
      remoteMessageRef: 'hmac:x',
    },
  });
  if (profile.kind !== 'chat') throw new Error('expected a chat profile');
  return { ...profile.limits, ...overrides };
}

const REF: ArtifactRef = {
  artifactId: 'a'.repeat(32),
  title: 'Week plan',
  url: `https://oracle.test/a/${'a'.repeat(32)}#k=key`,
  mime: 'text/markdown',
  bytes: 1200,
  expiresAt: '2026-10-25T09:00:00.000Z',
};

function toolResult(ref: ArtifactRef): string {
  return JSON.stringify({ ok: true, ...ref });
}

const FILE: ReplyFile = {
  url: 'https://r2.example/o/report.docx?X-Amz-Signature=deadbeef',
  filename: 'report.docx',
  mimetype:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  caption: 'The Q3 report',
  expiresAt: '2026-11-02T13:00:00.000Z',
};

/** A `send_file` result as the tool returns it: the link is out of `content`. */
function sendFileMessage(
  id: string,
  file: ReplyFile = FILE,
  path?: string,
): ToolMessage {
  return new ToolMessage({
    tool_call_id: id,
    name: 'send_file',
    content: JSON.stringify({ ok: true, filename: file.filename }),
    artifact: { ...file, path: path ?? `/output/${file.filename}` },
  });
}

function sendFileCall(id: string, path = '/output/report.docx') {
  return { id, name: 'send_file', args: { path } };
}

/** Build the plan of a finished turn from its messages. */
async function planOf(messages: BaseMessage[]): Promise<ReplyPlan> {
  const { steps, toolResults, toolArtifacts } = turnSteps(messages);
  return materializeReplyPlan(
    draftReplyPlan({
      steps,
      toolResults,
      toolArtifacts,
      limits: limits(),
      canSpill: true,
    }),
    {
      limits: limits(),
      createSpill: () => Promise.reject(new Error('no spill expected')),
    },
  );
}

describe('turnSteps', () => {
  it('reads the steps after the last human message, without hidden attachment text', () => {
    const { steps, toolResults } = turnSteps([
      new HumanMessage('earlier question'),
      new AIMessage('earlier answer'),
      new HumanMessage('plan my week'),
      new AIMessage({
        content: 'extracted pdf text',
        additional_kwargs: { attachment: { filename: 'a.pdf' } },
      }),
      new AIMessage({
        content: 'Checking your calendar.',
        tool_calls: [{ id: 'call-1', name: 'calendar_list', args: {} }],
      }),
      new ToolMessage({ tool_call_id: 'call-1', content: '14 events' }),
      new AIMessage('You have 14 meetings this week.'),
    ]);
    expect(steps).toEqual([
      {
        text: 'Checking your calendar.',
        toolCalls: [{ id: 'call-1', name: 'calendar_list', args: {} }],
      },
      { text: 'You have 14 meetings this week.', toolCalls: [] },
    ]);
    expect(toolResults.get('call-1')).toBe('14 events');
  });
});

describe('isNarration', () => {
  it('is one short paragraph of prose', () => {
    expect(isNarration('Checking your calendar and inbox.')).toBe(true);
    expect(isNarration('Here is the plan:\n\n- one\n- two')).toBe(false);
    expect(isNarration('x'.repeat(201))).toBe(false);
  });
});

describe('draftReplyPlan', () => {
  it('projects the Hub tool reference as a structured action part', async () => {
    const id = 'H'.repeat(32);
    const actionReference = {
      version: 'ixo.auth-action/1',
      id,
      accountId: 'account-one',
      bindingId: 'chb_one',
      bindingRevision: 1,
      revision: 1,
      digest: 'a'.repeat(64),
      url: `https://hub.test/a/${id}`,
      expiresAt: 1999999999999,
      title: 'Review form',
    };
    const draft = draftReplyPlan({
      steps: [
        {
          text: 'I have prepared the form.',
          toolCalls: [{ id: 'hub-call', name: 'request_hub_action', args: {} }],
        },
      ],
      toolResults: new Map([
        [
          'hub-call',
          JSON.stringify({
            status: 'prepared',
            actionReference,
            summary: 'Review form',
          }),
        ],
      ]),
      limits: limits(),
      canSpill: false,
    });
    expect(draft).toContainEqual({
      kind: 'hub-action',
      actionReference,
      summary: 'Review form',
    });
    const plan = await materializeReplyPlan(draft, {
      limits: limits(),
      createSpill: async () => REF,
    });
    expect(parseReplyPlan(JSON.stringify(plan))).toEqual(plan);
    expect(planText(plan)).toContain(actionReference.url);
    // A chain transaction review (a coin send included) is the same
    // structured part, and the note a chat surface's prepared result
    // carries does not change it.
    expect(
      draftReplyPlan({
        steps: [
          {
            text: 'Review the transfer.',
            toolCalls: [
              { id: 'pay-call', name: 'request_chain_transaction', args: {} },
            ],
          },
        ],
        toolResults: new Map([
          [
            'pay-call',
            JSON.stringify({
              status: 'prepared',
              actionReference,
              summary: 'Review form',
              note: HUB_ACTION_CARD_NOTE,
            }),
          ],
        ]),
        limits: limits(),
        canSpill: false,
      }),
    ).toContainEqual({
      kind: 'hub-action',
      actionReference,
      summary: 'Review form',
    });
  });
  it('turns a prepared Yoma application or claim card into the same review card', () => {
    const id = 'Y'.repeat(32);
    const actionReference = {
      version: 'ixo.auth-action/1',
      id,
      accountId: 'account-one',
      bindingId: 'chb_one',
      bindingRevision: 1,
      revision: 1,
      digest: 'b'.repeat(64),
      url: `https://hub.test/a/${id}`,
      expiresAt: 1999999999999,
      title: 'Send your work in',
    };
    const plan = draftReplyPlan({
      steps: [
        {
          text: '',
          toolCalls: [{ id: 'yoma-call', name: 'yoma_form', args: {} }],
        },
      ],
      toolResults: new Map([
        [
          'yoma-call',
          JSON.stringify({
            ok: true,
            status: 'prepared',
            summary: actionReference.title,
            actionReference,
            note: HUB_ACTION_CARD_NOTE,
          }),
        ],
      ]),
      limits: limits(),
      canSpill: false,
    });
    expect(plan).toContainEqual({
      kind: 'hub-action',
      actionReference,
      summary: actionReference.title,
    });
    // Another answer from the same tool (a question, a draft) is no card.
    expect(
      draftReplyPlan({
        steps: [
          {
            text: 'Next question.',
            toolCalls: [{ id: 'yoma-q', name: 'yoma_form', args: {} }],
          },
        ],
        toolResults: new Map([
          ['yoma-q', JSON.stringify({ ok: true, status: 'question' })],
        ]),
        limits: limits(),
        canSpill: false,
      }).some((part) => part.kind === 'hub-action'),
    ).toBe(false);
  });
  it('drops narration before a tool call but keeps substantive text written before one', () => {
    const plan = draftReplyPlan({
      steps: [
        {
          text: 'Checking your calendar.',
          toolCalls: [{ id: 'c1', name: 'calendar_list', args: {} }],
        },
        {
          text: 'I will block two focus mornings for the board deck and move the Wednesday 1:1 so the afternoon stays free.\n\nCreating the events now.',
          toolCalls: [{ id: 'c2', name: 'calendar_create', args: {} }],
        },
        { text: 'Done. Both blocks are in your calendar.', toolCalls: [] },
      ],
      toolResults: new Map(),
      limits: limits(),
      canSpill: true,
    });
    expect(plan).toEqual([
      {
        kind: 'text',
        text: 'I will block two focus mornings for the board deck and move the Wednesday 1:1 so the afternoon stays free.',
      },
      { kind: 'text', text: 'Creating the events now.' },
      { kind: 'text', text: 'Done. Both blocks are in your calendar.' },
    ]);
  });

  it('keeps a short answer written alongside a tool call when nothing follows it', () => {
    const plan = draftReplyPlan({
      steps: [
        {
          text: 'Your flight is 9:40, gate B12.',
          toolCalls: [{ id: 'c1', name: 'memory_save', args: {} }],
        },
        { text: '', toolCalls: [] },
      ],
      toolResults: new Map(),
      limits: limits(),
      canSpill: true,
    });
    expect(plan).toEqual([
      { kind: 'text', text: 'Your flight is 9:40, gate B12.' },
    ]);
    // With a later reply, the same line is narration and goes.
    expect(
      draftReplyPlan({
        steps: [
          {
            text: 'Your flight is 9:40, gate B12.',
            toolCalls: [{ id: 'c1', name: 'memory_save', args: {} }],
          },
          { text: 'Saved it.', toolCalls: [] },
        ],
        toolResults: new Map(),
        limits: limits(),
        canSpill: true,
      }),
    ).toEqual([{ kind: 'text', text: 'Saved it.' }]);
  });

  it('turns a create_artifact call into its message, the link and its question', () => {
    const plan = draftReplyPlan({
      steps: [
        {
          text: 'Here you go.',
          toolCalls: [
            {
              id: 'c1',
              name: 'create_artifact',
              args: {
                title: 'Week plan',
                content: '# Week plan',
                message: 'Your week: 14 meetings and three deadlines.',
                followUp: 'Want me to block focus time?',
              },
            },
          ],
        },
      ],
      toolResults: new Map([['c1', toolResult(REF)]]),
      limits: limits(),
      canSpill: true,
    });
    expect(plan).toEqual([
      { kind: 'text', text: 'Your week: 14 meetings and three deadlines.' },
      { kind: 'artifact', artifact: REF },
      { kind: 'text', text: 'Want me to block focus time?' },
    ]);
  });

  it('keeps the message when create_artifact failed', () => {
    const plan = draftReplyPlan({
      steps: [
        {
          text: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'create_artifact',
              args: {
                title: 'T',
                content: 'x',
                message: 'The short version: 3 options.',
              },
            },
          ],
        },
      ],
      toolResults: new Map([['c1', 'Error: storage unavailable']]),
      limits: limits(),
      canSpill: true,
    });
    expect(plan).toEqual([
      { kind: 'text', text: 'The short version: 3 options.' },
    ]);
  });

  it('puts the text a run had produced before a reset in front of the final step', () => {
    const plan = draftReplyPlan({
      steps: [{ text: 'and the deck is due Wednesday.', toolCalls: [] }],
      toolResults: new Map(),
      continuation: 'You have 14 meetings this week, ',
      limits: limits(),
      canSpill: true,
    });
    expect(plan).toEqual([
      {
        kind: 'text',
        text: 'You have 14 meetings this week, and the deck is due Wednesday.',
      },
    ]);
  });

  it('does not repeat a step the checkpoint kept when it puts back the text before a reset', () => {
    const kept =
      'Two things first:\n\n- the offsite moved to Friday\n- Sam is out on Monday';
    const plan = draftReplyPlan({
      steps: [
        {
          text: kept,
          toolCalls: [{ id: 'call-1', name: 'calendar_list', args: {} }],
        },
        { text: 'and the deck is due Wednesday.', toolCalls: [] },
      ],
      toolResults: new Map(),
      continuation: `${kept}\n\nYou have 14 meetings this week, `,
      limits: limits(),
      canSpill: true,
    });
    expect(plan).toEqual([
      { kind: 'text', text: kept },
      {
        kind: 'text',
        text: 'You have 14 meetings this week, and the deck is due Wednesday.',
      },
    ]);
  });

  it('puts the text left after every kept step behind the last step, not in front of it', () => {
    const kept = 'Two things first: the offsite moved to Friday.';
    const plan = draftReplyPlan({
      steps: [
        {
          text: kept,
          toolCalls: [{ id: 'call-1', name: 'calendar_list', args: {} }],
        },
      ],
      toolResults: new Map(),
      continuation: `${kept} And Sam is out on Monday.`,
      limits: limits(),
      canSpill: true,
    });
    expect(plan).toEqual([
      {
        kind: 'text',
        text: `${kept} And Sam is out on Monday.`,
      },
    ]);
  });

  it('delivers the text from before a reset when the resumed run produced no step', () => {
    const plan = draftReplyPlan({
      steps: [],
      toolResults: new Map(),
      continuation: 'You have 14 meetings this week.',
      limits: limits(),
      canSpill: true,
    });
    expect(plan).toEqual([
      { kind: 'text', text: 'You have 14 meetings this week.' },
    ]);
  });

  it('adds nothing when the whole reply had been streamed before the reset', () => {
    const plan = draftReplyPlan({
      steps: [{ text: 'You have 14 meetings this week.', toolCalls: [] }],
      toolResults: new Map(),
      continuation: 'You have 14 meetings this week.',
      limits: limits(),
      canSpill: true,
    });
    expect(plan).toEqual([
      { kind: 'text', text: 'You have 14 meetings this week.' },
    ]);
  });
});

describe('a send_file call in the plan', () => {
  it('becomes a file part with the link the model never saw', async () => {
    const plan = await planOf([
      new HumanMessage('Make me the report as a Word file'),
      new AIMessage({ content: '', tool_calls: [sendFileCall('f1')] }),
      sendFileMessage('f1'),
      new AIMessage('Here is the Q3 report.'),
    ]);
    expect(plan).toEqual({
      v: 1,
      parts: [
        { partId: 'p1', kind: 'file', file: FILE },
        { partId: 'p2', kind: 'text', text: 'Here is the Q3 report.' },
      ],
    });
    expect(parseReplyPlan(JSON.stringify(plan))).toEqual(plan);
  });

  it('keeps its place among the text, cards and other files of the reply', async () => {
    const second = { ...FILE, filename: 'data.xlsx', caption: undefined };
    const id = 'H'.repeat(32);
    const actionReference = {
      version: 'ixo.auth-action/1',
      id,
      accountId: 'account-one',
      bindingId: 'chb_one',
      bindingRevision: 1,
      revision: 1,
      digest: 'a'.repeat(64),
      url: `https://hub.test/a/${id}`,
      expiresAt: 1999999999999,
      title: 'Review form',
    };
    const plan = await planOf([
      new HumanMessage('Send the pack'),
      new AIMessage({
        content: `${'Here is everything you asked for this quarter, with the numbers checked against the ledger. '.repeat(3)}`,
        tool_calls: [sendFileCall('f1')],
      }),
      sendFileMessage('f1'),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'hub', name: 'request_hub_action', args: {} },
          sendFileCall('f2', '/output/data.xlsx'),
          {
            id: 'c1',
            name: 'create_artifact',
            args: {
              title: 'Notes',
              content: '# Notes',
              message: 'The notes.',
              followUp: 'Anything else?',
            },
          },
        ],
      }),
      new ToolMessage({
        tool_call_id: 'hub',
        content: JSON.stringify({
          status: 'prepared',
          actionReference,
          summary: 'Review form',
        }),
      }),
      // Results arrive in any order; the plan keeps the order of the calls.
      new ToolMessage({ tool_call_id: 'c1', content: toolResult(REF) }),
      sendFileMessage('f2', second),
    ]);
    expect(plan.parts.map((part) => part.kind)).toEqual([
      'text',
      'file',
      'hub-action',
      'file',
      'text',
      'artifact',
      'text',
    ]);
    expect(
      plan.parts.flatMap((part) =>
        part.kind === 'file' ? [part.file.filename] : [],
      ),
    ).toEqual(['report.docx', 'data.xlsx']);
  });

  it('keeps a short line written with the call when nothing follows it', async () => {
    const plan = await planOf([
      new HumanMessage('Send it'),
      new AIMessage({
        content: 'Here is the report.',
        tool_calls: [sendFileCall('f1')],
      }),
      sendFileMessage('f1'),
      new AIMessage(''),
    ]);
    expect(plan.parts.map((part) => part.kind)).toEqual(['text', 'file']);
  });

  it('adds nothing for a failed lookup or a malformed result', async () => {
    const plan = await planOf([
      new HumanMessage('Send it'),
      new AIMessage({
        content: '',
        tool_calls: [
          sendFileCall('f1'),
          sendFileCall('f2'),
          sendFileCall('f3'),
        ],
      }),
      new ToolMessage({
        tool_call_id: 'f1',
        content: JSON.stringify({ ok: false, error: 'No stored file' }),
      }),
      new ToolMessage({
        tool_call_id: 'f2',
        content: '{}',
        artifact: { ...FILE, url: 'http://r2.example/plain' },
      }),
      new ToolMessage({ tool_call_id: 'f3', content: 'not run', artifact: 7 }),
      new AIMessage('I could not find that file.'),
    ]);
    expect(plan.parts).toEqual([
      { partId: 'p1', kind: 'text', text: 'I could not find that file.' },
    ]);
  });

  it('never loses a file to the part cap, and keeps the order of several', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      ...FILE,
      filename: `file-${i}.pdf`,
    }));
    const messages: BaseMessage[] = [new HumanMessage('Send all five')];
    files.forEach((file, i) => {
      messages.push(
        new AIMessage({
          content: `${'Part of a long explanation that is not narration. '.repeat(5)}${i}`,
          tool_calls: [sendFileCall(`f${i}`, `/output/${file.filename}`)],
        }),
        sendFileMessage(`f${i}`, file),
      );
    });
    messages.push(new AIMessage('All five are above.'));
    const { steps, toolResults, toolArtifacts } = turnSteps(messages);
    const tight = limits({ maxPartsPerRun: 3 });
    const plan = await materializeReplyPlan(
      draftReplyPlan({
        steps,
        toolResults,
        toolArtifacts,
        limits: tight,
        canSpill: true,
      }),
      { limits: tight, createSpill: () => Promise.reject(new Error('no')) },
    );
    expect(
      plan.parts.flatMap((part) =>
        part.kind === 'file' ? [part.file.filename] : [],
      ),
    ).toEqual(files.map((file) => file.filename));
    expect(plan.parts.filter((part) => part.kind === 'text')).toHaveLength(6);
  });

  it('merges the text around files without dropping one, and drops framing first', async () => {
    const tight = limits({ maxPartsPerRun: 2 });
    const plan = await materializeReplyPlan(
      [
        { kind: 'file', file: FILE },
        { kind: 'text', text: 'One.' },
        { kind: 'text', text: 'Two.' },
        { kind: 'file', file: FILE },
      ],
      { limits: tight, createSpill: () => Promise.reject(new Error('no')) },
    );
    expect(plan.parts.map((part) => part.kind)).toEqual([
      'file',
      'text',
      'file',
    ]);
  });

  it('survives a reset: the checkpoint keeps the link and the resumed run delivers it', async () => {
    const roundTrip = (message: BaseMessage): Promise<BaseMessage> =>
      // What `SqliteSaver` writes to and reads from a message row.
      new MemorySaver().serde.loadsTyped(
        'json',
        stringify(message, (_key, value) => _default(value)),
      ) as Promise<BaseMessage>;
    const beforeReset = await Promise.all(
      [
        new HumanMessage('Make the report'),
        new AIMessage({ content: '', tool_calls: [sendFileCall('f1')] }),
        sendFileMessage('f1'),
      ].map(roundTrip),
    );
    expect(ToolMessage.isInstance(beforeReset[2])).toBe(true);
    // The resumed run's last step, and the text streamed before the reset.
    const { steps, toolResults, toolArtifacts } = turnSteps([
      ...beforeReset,
      new AIMessage('Here it is.'),
    ]);
    const plan = await materializeReplyPlan(
      draftReplyPlan({
        steps,
        toolResults,
        toolArtifacts,
        continuation: 'Almost done. ',
        limits: limits(),
        canSpill: true,
      }),
      { limits: limits(), createSpill: () => Promise.reject(new Error('no')) },
    );
    expect(plan.parts).toEqual([
      { partId: 'p1', kind: 'file', file: FILE },
      { partId: 'p2', kind: 'text', text: 'Almost done. Here it is.' },
    ]);
  });

  it('delivers a re-run of an interrupted call, with its new signature', async () => {
    const resigned = { ...FILE, url: `${FILE.url}2` };
    // The reset cut the first attempt off before its result was stored: the
    // resumed run ran the same call again.
    const plan = await planOf([
      new HumanMessage('Make the report'),
      new AIMessage({ content: '', tool_calls: [sendFileCall('f1')] }),
      sendFileMessage('f1', resigned),
    ]);
    expect(plan.parts).toEqual([
      { partId: 'p1', kind: 'file', file: resigned },
    ]);
  });

  it('survives a mid-turn summary that condensed the call away', async () => {
    const opening = new HumanMessage({ id: 'h1', content: 'Make the report' });
    const ai = new AIMessage({
      id: 'a1',
      content: '',
      tool_calls: [sendFileCall('f1')],
    });
    const result = sendFileMessage('f1');
    result.id = 't1';
    const failed = new ToolMessage({
      id: 't2',
      tool_call_id: 'f2',
      content: JSON.stringify({ ok: false, error: 'No stored file' }),
    });
    const calls = carriedCallsOfTurn(
      [
        opening,
        ai,
        result,
        new AIMessage({
          id: 'a2',
          content: '',
          tool_calls: [sendFileCall('f2')],
        }),
        failed,
      ],
      new Set(),
    );
    const summary = new HumanMessage({
      id: 's1',
      content: `${SUMMARY_PREFIX} the turn so far`,
      additional_kwargs: {
        lc_source: 'summarization',
        ...turnCarryKwargs(calls ?? []),
      },
    });
    const plan = await planOf([
      new HumanMessage('an earlier question'),
      new AIMessage('an earlier answer'),
      summary,
      new AIMessage('Done, the report is above.'),
    ]);
    expect(plan.parts).toEqual([
      { partId: 'p1', kind: 'file', file: FILE },
      { partId: 'p2', kind: 'text', text: 'Done, the report is above.' },
    ]);
  });

  it('keeps a file sent before an attachment was viewed again in the same turn', async () => {
    const plan = await planOf([
      new HumanMessage('Send the report'),
      new AIMessage({ content: '', tool_calls: [sendFileCall('f1')] }),
      sendFileMessage('f1'),
      new HumanMessage({
        content: 'the re-attached file',
        additional_kwargs: { lc_source: ATTACHMENT_VIEW_SOURCE },
      }),
      new AIMessage('Sent.'),
    ]);
    expect(plan.parts.map((part) => part.kind)).toEqual(['file', 'text']);
  });

  it('delivers a file sent twice once, at its first place, whatever path the model used', async () => {
    const resigned = { ...FILE, url: `${FILE.url}2`, caption: 'Again' };
    const other = { ...FILE, filename: 'data.xlsx' };
    const plan = await planOf([
      new HumanMessage('Send the report and the data'),
      new AIMessage({
        content: '',
        tool_calls: [
          sendFileCall('f1'),
          sendFileCall('f2', '/workspace/data/output/report.docx'),
          sendFileCall('f3', '/output/data.xlsx'),
        ],
      }),
      sendFileMessage('f1'),
      // The store normalised the alias to the same path.
      sendFileMessage('f2', resigned, '/output/report.docx'),
      sendFileMessage('f3', other),
      new AIMessage({ content: '', tool_calls: [sendFileCall('f4')] }),
      sendFileMessage('f4', resigned),
      new AIMessage('Both sent.'),
    ]);
    expect(plan.parts).toEqual([
      { partId: 'p1', kind: 'file', file: FILE },
      { partId: 'p2', kind: 'file', file: other },
      { partId: 'p3', kind: 'text', text: 'Both sent.' },
    ]);
  });

  it('sends the model only the content of the result, never the link', () => {
    const [param] = convertMessagesToCompletionsMessageParams({
      messages: [sendFileMessage('f1')],
    });
    expect(JSON.stringify(param)).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(param)).not.toContain('r2.example');
  });
});

describe('failedRunFiles', () => {
  const turn = (): BaseMessage[] => [
    new HumanMessage('Make the report'),
    new AIMessage({ content: 'On it.', tool_calls: [sendFileCall('f1')] }),
    sendFileMessage('f1'),
  ];

  it('delivers what the run sent, without its text, and says the rest is missing', async () => {
    const plan = await failedRunFiles(turn(), new Set(['f1']), limits());
    expect(plan).toEqual({
      v: 1,
      parts: [
        { partId: 'p1', kind: 'file', file: FILE },
        { partId: 'p2', kind: 'text', text: FAILED_RUN_NOTICE },
      ],
    });
    expect(parseReplyPlan(JSON.stringify(plan))).toEqual(plan);
  });

  it('never delivers the file of an earlier turn again', async () => {
    // The run failed before it wrote anything: the checkpoint still ends in
    // the previous turn, and its marks name none of those calls.
    expect(await failedRunFiles(turn(), new Set(), limits())).toBeNull();
    expect(
      await failedRunFiles(turn(), new Set(['other']), limits()),
    ).toBeNull();
  });

  it('is nothing for a run that sent no file, or whose lookup failed', async () => {
    expect(
      await failedRunFiles(
        [
          new HumanMessage('Hi'),
          new AIMessage({ content: 'Hi', tool_calls: [sendFileCall('f1')] }),
          new ToolMessage({
            tool_call_id: 'f1',
            content: JSON.stringify({ ok: false, error: 'No stored file' }),
          }),
        ],
        new Set(['f1']),
        limits(),
      ),
    ).toBeNull();
  });

  it('delivers a file a mid-turn summary carried', async () => {
    const calls = carriedCallsOfTurn(
      [
        new HumanMessage({ id: 'h1', content: 'Make the report' }),
        new AIMessage({
          id: 'a1',
          content: '',
          tool_calls: [sendFileCall('f1')],
        }),
        Object.assign(sendFileMessage('f1'), { id: 't1' }),
      ],
      new Set(),
    );
    const plan = await failedRunFiles(
      [
        new HumanMessage({
          content: `${SUMMARY_PREFIX} the turn so far`,
          additional_kwargs: {
            lc_source: 'summarization',
            ...turnCarryKwargs(calls ?? []),
          },
        }),
      ],
      new Set(['f1']),
      limits(),
    );
    expect(plan?.parts[0]).toEqual({ partId: 'p1', kind: 'file', file: FILE });
  });
});

describe('planText with a file', () => {
  const plan = {
    parts: [
      { kind: 'text' as const, text: 'Done.' },
      { kind: 'file' as const, file: FILE },
      {
        kind: 'file' as const,
        file: { ...FILE, filename: 'a[1].pdf', caption: undefined },
      },
    ],
  };

  it('gives a gateway that cannot read the part a link line, with the caption', () => {
    expect(planText(plan)).toBe(
      `Done.\n\nThe Q3 report\n\n[report.docx](${FILE.url})\n\n[a1.pdf](${FILE.url})`,
    );
  });

  it('never shows the model the link', () => {
    const text = planTextForModel(plan);
    expect(text).not.toContain('X-Amz-Signature');
    expect(text).toBe(
      'Done.\n\nThe Q3 report\n\n[File sent: report.docx]\n\n[File sent: a[1].pdf]',
    );
  });
});

describe('materializeReplyPlan', () => {
  const spillDraft: DraftPart = {
    kind: 'spill',
    key: 'step-0',
    spill: {
      title: 'Week plan',
      markdown:
        '## Week plan\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nShall I book it?',
      lead: 'Your week is busy.',
      closing: 'Shall I book it?',
    },
  };

  it('expands a spill into lead, artefact and closing question, numbered in order', async () => {
    const createSpill = vi.fn(async () => REF);
    const plan = await materializeReplyPlan([spillDraft], {
      limits: limits(),
      createSpill,
    });
    expect(createSpill).toHaveBeenCalledWith('step-0', spillDraft.spill);
    expect(plan).toEqual({
      v: 1,
      parts: [
        { partId: 'p1', kind: 'text', text: 'Your week is busy.' },
        { partId: 'p2', kind: 'artifact', artifact: REF },
        { partId: 'p3', kind: 'text', text: 'Shall I book it?' },
      ],
    });
    expect(parseReplyPlan(JSON.stringify(plan))).toEqual(plan);
    expect(planText(plan)).toBe(
      `Your week is busy.\n\n[Week plan](${REF.url})\n\nShall I book it?`,
    );
  });

  it('falls back to plain messages when the artefact cannot be created', async () => {
    const onSpillError = vi.fn();
    const plan = await materializeReplyPlan([spillDraft], {
      limits: limits(),
      createSpill: async () => {
        throw new Error('bucket unavailable');
      },
      onSpillError,
    });
    expect(onSpillError).toHaveBeenCalledTimes(1);
    // The table became a list; too short to stand alone, it joins the question.
    expect(
      plan.parts.map((p) => (p.kind === 'text' ? p.text : p.kind)),
    ).toEqual(['**Week plan**\n\n- **1** · B: 2\n\nShall I book it?']);
  });

  it('merges the shortest neighbouring messages over the run cap, links untouched', async () => {
    const draft: DraftPart[] = [
      { kind: 'text', text: 'one' },
      { kind: 'text', text: 'two' },
      { kind: 'artifact', artifact: REF },
      { kind: 'text', text: 'three is longer than the others' },
      { kind: 'text', text: 'four' },
    ];
    const plan = await materializeReplyPlan(draft, {
      limits: limits({ maxPartsPerRun: 3 }),
      createSpill: async () => REF,
    });
    expect(plan.parts).toEqual([
      { partId: 'p1', kind: 'text', text: 'one\n\ntwo' },
      { partId: 'p2', kind: 'artifact', artifact: REF },
      {
        partId: 'p3',
        kind: 'text',
        text: 'three is longer than the others\n\nfour',
      },
    ]);
  });

  it('never merges messages past the hard size to meet the cap', async () => {
    const chunks = Array.from({ length: 8 }, (_, i) =>
      `${i} `.padEnd(700, 'x'),
    );
    const plan = await materializeReplyPlan(
      chunks.map((text): DraftPart => ({ kind: 'text', text })),
      { limits: limits({ maxPartsPerRun: 3 }), createSpill: async () => REF },
    );
    const texts = plan.parts.map((p) => (p.kind === 'text' ? p.text : ''));
    // Pairs fit the 1,500-character hard size; a third message would not.
    expect(texts).toHaveLength(4);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(1500);
    expect(texts.join('\n\n')).toBe(chunks.join('\n\n'));
  });

  it('drops spill leads and closings, which the artefacts hold, before going over the cap', async () => {
    const budget: ArtifactRef = {
      ...REF,
      artifactId: 'b'.repeat(32),
      title: 'Budget',
    };
    const second: DraftPart = {
      kind: 'spill',
      key: 'step-1',
      spill: {
        title: 'Budget',
        markdown: '## Budget\n\n| A | B |\n|---|---|\n| 1 | 2 |',
        lead: 'The budget is tight.',
        closing: 'Want the breakdown?',
      },
    };
    const plan = await materializeReplyPlan([spillDraft, second], {
      limits: limits({ maxPartsPerRun: 3 }),
      createSpill: async (key) => (key === 'step-0' ? REF : budget),
    });
    expect(plan.parts).toEqual([
      { partId: 'p1', kind: 'artifact', artifact: REF },
      { partId: 'p2', kind: 'artifact', artifact: budget },
      { partId: 'p3', kind: 'text', text: 'Want the breakdown?' },
    ]);
  });

  it('keeps a long chat answer and a card within the WhatsApp cap by merging messages', async () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      `Paragraph ${i + 1} of a long answer that stays in chat. `
        .repeat(5)
        .trim(),
    );
    // As one step, the shaper already groups it: pairs fit `bubbleTarget`
    // (five messages, over the preferred three), so it fills up to
    // `bubbleMax`: six and four paragraphs.
    expect(
      draftReplyPlan({
        steps: [{ text: paragraphs.join('\n\n'), toolCalls: [] }],
        toolResults: new Map(),
        limits: limits(),
        canSpill: true,
      }),
    ).toHaveLength(2);
    // Ten messages (from several steps) and a card meet the run's cap.
    const draft: DraftPart[] = [
      ...paragraphs.map((text): DraftPart => ({ kind: 'text', text })),
      { kind: 'artifact', artifact: REF },
    ];
    const plan = await materializeReplyPlan(draft, {
      limits: limits(),
      createSpill: vi.fn(),
    });
    expect(limits().maxPartsPerRun).toBe(8);
    expect(plan.parts).toHaveLength(8);
    expect(plan.parts.at(-1)).toMatchObject({ kind: 'artifact' });
    const texts = plan.parts.flatMap((p) =>
      p.kind === 'text' ? [p.text] : [],
    );
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(1500);
    expect(texts.join('\n\n')).toBe(paragraphs.join('\n\n'));
  });

  it('keeps text found nowhere else, even over the cap', async () => {
    const draft: DraftPart[] = [
      { kind: 'text', text: 'Here is the deck.' },
      { kind: 'artifact', artifact: REF },
      { kind: 'text', text: 'And the budget.' },
      { kind: 'artifact', artifact: { ...REF, artifactId: 'b'.repeat(32) } },
    ];
    const plan = await materializeReplyPlan(draft, {
      limits: limits({ maxPartsPerRun: 2 }),
      createSpill: async () => REF,
    });
    expect(plan.parts).toHaveLength(4);
  });
  it('never sends a part that is only whitespace or zero-width characters', async () => {
    const plan = await materializeReplyPlan(
      [
        { kind: 'text', text: '\u200B\u200C \uFEFF' },
        { kind: 'text', text: 'Done.' },
      ],
      { limits: limits(), createSpill: vi.fn() },
    );
    expect(plan.parts).toEqual([{ partId: 'p1', kind: 'text', text: 'Done.' }]);
    expect(
      draftReplyPlan({
        steps: [{ text: '\u200B', toolCalls: [] }],
        toolResults: new Map(),
        limits: limits(),
        canSpill: true,
      }),
    ).toEqual([]);
  });
});

describe('parseReplyPlan', () => {
  it('reads a file part, and refuses one that is not https or lacks a name', () => {
    const plan = (file: unknown): string =>
      JSON.stringify({ v: 1, parts: [{ partId: 'p1', kind: 'file', file }] });
    expect(parseReplyPlan(plan(FILE))?.parts[0]).toEqual({
      partId: 'p1',
      kind: 'file',
      file: FILE,
    });
    expect(
      parseReplyPlan(
        plan({ url: FILE.url, filename: 'a', mimetype: 'text/plain' }),
      ),
    ).not.toBeNull();
    expect(
      parseReplyPlan(plan({ ...FILE, url: 'http://x.test/a' })),
    ).toBeNull();
    expect(parseReplyPlan(plan({ ...FILE, filename: '' }))).toBeNull();
    // The bounds of a gateway's parser: anything else would fall back to text.
    expect(
      parseReplyPlan(
        plan({
          ...FILE,
          url: `https://r2.example/${'a'.repeat(REPLY_FILE_URL_MAX)}`,
        }),
      ),
    ).toBeNull();
    expect(
      parseReplyPlan(plan({ ...FILE, url: 'https://u:p@r2.example/a' })),
    ).toBeNull();
    expect(
      parseReplyPlan(plan({ ...FILE, caption: 'x'.repeat(1025) })),
    ).toBeNull();
  });

  it('rejects a malformed plan', () => {
    expect(parseReplyPlan('{"v":2,"parts":[]}')).toBeNull();
    expect(parseReplyPlan('not json')).toBeNull();
    expect(parseReplyPlan(undefined)).toBeNull();
  });
});
