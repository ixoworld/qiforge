import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { resolveDeliveryProfile } from './profile';
import {
  draftReplyPlan,
  isNarration,
  materializeReplyPlan,
  turnSteps,
  type DraftPart,
} from './plan';
import { parseReplyPlan, planText } from './schema';
import type { ArtifactRef, ChatLimits } from './types';

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
});

describe('parseReplyPlan', () => {
  it('rejects a malformed plan', () => {
    expect(parseReplyPlan('{"v":2,"parts":[]}')).toBeNull();
    expect(parseReplyPlan('not json')).toBeNull();
    expect(parseReplyPlan(undefined)).toBeNull();
  });
});
