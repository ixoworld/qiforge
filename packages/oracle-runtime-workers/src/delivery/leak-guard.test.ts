import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  echoesToolOutput,
  jsonToolOutputs,
  withoutReasoningTags,
} from './leak-guard';
import { draftReplyPlan, turnSteps } from './plan';
import { resolveDeliveryProfile } from './profile';

const AWAITING =
  '{"ok":false,"status":"awaiting_user","say":"Wait for the person to answer the question."}';

describe('withoutReasoningTags', () => {
  it.each([
    ['<think>The user wants X.</think>\n\nHere you go.', 'Here you go.'],
    [
      'The user wants X, so I answer.\n</think>\n\nHere you go.',
      'Here you go.',
    ],
    ['Here you go.<thinking>maybe add more', 'Here you go.'],
    ['<reasoning>a</reasoning>A<THINK>b</THINK>B', 'AB'],
    ['No tags here, 2 < 3 and 4 > 1.', 'No tags here, 2 < 3 and 4 > 1.'],
  ])('%j → %j', (text, expected) => {
    expect(withoutReasoningTags(text)).toBe(expected);
  });
});

describe('echoesToolOutput', () => {
  it('finds a JSON tool result quoted verbatim, and ignores plain-text results', () => {
    const outputs = jsonToolOutputs([
      AWAITING,
      'Your balance is 20 IXO today.',
      '{}',
    ]);
    expect(outputs).toEqual([AWAITING]);
    expect(
      echoesToolOutput(
        `\`\n\`\n${AWAITING}\`\n\nThis means I already…`,
        outputs,
      ),
    ).toBe(true);
    expect(echoesToolOutput('Your balance is 20 IXO today.', outputs)).toBe(
      false,
    );
  });
});

describe('a turn whose fallback model thought aloud into its content (13 Nov 2026)', () => {
  /**
   * The shape of the leaked Qwen step (LangSmith run 01a1d4e4-…, text
   * shortened, nothing personal): reasoning that quotes the turn's tool
   * result, then a tool call; then the clean question from the next step.
   */
  const messages = [
    new HumanMessage('I tried selling clothes'),
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'c1', name: 'yoma_form', args: { action: 'answer' } }],
    }),
    new ToolMessage({
      tool_call_id: 'c1',
      name: 'yoma_form',
      content: AWAITING,
    }),
    new AIMessage({
      content: `\`\n\`\n${AWAITING}\`\n\nThis means I *already* made that tool call in the previous turn. The system is telling me… I should ask for the offer.\n\nSo I will send: "Did someone offer to pay you?"\n\nLet's do that.\n\n\nDid someone offer to pay you?`,
      tool_calls: [{ id: 'c2', name: 'yoma_form', args: { action: 'answer' } }],
    }),
    new ToolMessage({
      tool_call_id: 'c2',
      name: 'yoma_form',
      content: AWAITING,
    }),
    new AIMessage(
      'Did someone actually offer to pay you, or were you still trying to get an offer?',
    ),
  ];

  it('delivers only the clean reply', () => {
    const { steps, toolResults } = turnSteps(messages);
    expect(steps[1]).toMatchObject({ text: '', withheld: 'tool_output' });
    const chat = resolveDeliveryProfile({
      client: 'channel',
      channel: { provider: 'whatsapp', bindingId: 'b', remoteMessageRef: 'r' },
    });
    if (chat.kind !== 'chat') throw new Error('unreachable');
    const parts = draftReplyPlan({
      steps,
      toolResults,
      limits: chat.limits,
      canSpill: false,
    });
    expect(parts).toEqual([
      {
        kind: 'text',
        text: 'Did someone actually offer to pay you, or were you still trying to get an offer?',
      },
    ]);
  });

  it('keeps a step that ends its thinking with a closing tag, without the thinking', () => {
    const { steps } = turnSteps([
      new HumanMessage('hi'),
      new AIMessage(
        'The user greets me, I greet back.\n</think>\n\nHi! How can I help?',
      ),
    ]);
    expect(steps).toEqual([{ text: 'Hi! How can I help?', toolCalls: [] }]);
  });
});
