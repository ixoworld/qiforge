import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClefRequest, ClefResponse, ClefRunner } from './clef';
import {
  CLEF_TIMEOUT_MS,
  judgeChoice,
  judgeLiterally,
  multiChoiceRequest,
  singleChoiceRequest,
  type ChoiceQuestion,
} from './judge';

afterEach(() => {
  vi.useRealTimers();
});

const limits = () => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 20_000,
});

const country: ChoiceQuestion = {
  title: 'Which country do you live in?',
  multiple: false,
  options: ['South Africa', 'Zambia', 'Lesotho'],
  otherAllowed: true,
};

const skills: ChoiceQuestion = {
  title: 'What can you do?',
  multiple: true,
  // The form's "None" item comes last and goes on its own.
  options: ['Photos', 'Mapping', 'Surveys', 'None of these'],
  exclusive: [3],
  otherAllowed: false,
};

/** A single choice with the form's "None" and "Don't know" items switched on. */
const transport: ChoiceQuestion = {
  title: 'How do you get to work?',
  multiple: false,
  options: ['Bus', 'Taxi', 'None', "Don't know"],
  otherAllowed: false,
};

/** Options that are numbers themselves. */
const people: ChoiceQuestion = {
  title: 'How many people helped?',
  multiple: false,
  options: ['5', '10', '20'],
  otherAllowed: false,
};

/** A Clef that always picks `pick` with the given probability. */
const clefPicking =
  (pick: string, p = 0.95): ClefRunner =>
  async (request: ClefRequest): Promise<ClefResponse> => {
    const answers: ClefResponse['answers'] = {};
    for (const [id, q] of Object.entries(request.questions)) {
      if (q.type === 'choice')
        answers[id] = {
          type: 'choice',
          choice: pick,
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((k) => [k, k === pick ? p : 0.01]),
          ),
        };
      else answers[id] = { type: 'noul', noul: id === pick ? p : 0.02 };
    }
    return { model: 'clef', answers };
  };

describe('reading a choice reply', () => {
  it('takes an option number or the exact option text without Clef', () => {
    expect(judgeLiterally(country, '2')).toMatchObject({
      status: 'accepted',
      picked: [1],
      by: 'number',
    });
    expect(judgeLiterally(country, ' south africa ')).toMatchObject({
      status: 'accepted',
      picked: [0],
    });
    expect(judgeLiterally(skills, '1, 3')).toMatchObject({
      status: 'accepted',
      picked: [0, 2],
    });
    expect(judgeLiterally(country, '1, 3').status).toBe('unclear');
    expect(judgeLiterally(country, '9').status).toBe('unclear');
  });

  it('asks Clef for anything else, and reads its answer against the thresholds', async () => {
    expect(
      await judgeChoice(
        clefPicking('option_3'),
        country,
        'I stay in Maseru',
        undefined,
        limits(),
      ),
    ).toMatchObject({
      status: 'accepted',
      picked: [2],
      by: 'clef',
    });
    expect(
      (
        await judgeChoice(
          clefPicking('option_3', 0.5),
          country,
          'maybe Maseru',
          undefined,
          limits(),
        )
      ).status,
    ).toBe('unclear');
    expect(
      await judgeChoice(
        clefPicking('option_1'),
        skills,
        'I take pictures',
        undefined,
        limits(),
      ),
    ).toMatchObject({
      status: 'accepted',
      picked: [0],
    });
  });

  it('says unclear without Clef, and when Clef is down, never guessing', async () => {
    expect(
      (
        await judgeChoice(
          undefined,
          country,
          'I stay in Maseru',
          undefined,
          limits(),
        )
      ).status,
    ).toBe('unclear');
    const down: ClefRunner = async () => {
      throw new Error('Workers AI 503');
    };
    expect(
      await judgeChoice(down, country, 'I stay in Maseru', undefined, limits()),
    ).toMatchObject({
      status: 'unclear',
      clefFailed: true,
    });
    // A number still works while Clef is down.
    expect(
      await judgeChoice(down, country, '3', undefined, limits()),
    ).toMatchObject({
      status: 'accepted',
      picked: [2],
    });
  });

  it('reads the reply literally when Clef answers after the deadline, and rethrows an abort', async () => {
    const late: ClefRunner = () => new Promise(() => undefined);
    expect(
      await judgeChoice(late, country, 'Maseru', undefined, {
        signal: new AbortController().signal,
        deadline: Date.now() + 20,
      }),
    ).toMatchObject({ status: 'unclear', clefFailed: true });
    const turn = new AbortController();
    const pending = judgeChoice(late, country, 'Maseru', undefined, {
      signal: turn.signal,
      deadline: Date.now() + 20_000,
    });
    turn.abort(new Error('turn aborted'));
    await expect(pending).rejects.toThrow('turn aborted');
  });

  it("offers a single choice's None and Don't know like any option, by number, text and Clef", async () => {
    expect(judgeLiterally(transport, '3')).toMatchObject({
      status: 'accepted',
      picked: [2],
    });
    expect(judgeLiterally(transport, "don't know")).toMatchObject({
      status: 'accepted',
      picked: [3],
    });
    expect(
      Object.keys(
        singleChoiceRequest(transport, 'no idea').questions.answer!.type ===
          'choice'
          ? (
              singleChoiceRequest(transport, 'no idea').questions.answer as {
                criteria: Record<string, string>;
              }
            ).criteria
          : {},
      ),
    ).toEqual(['option_1', 'option_2', 'option_3', 'option_4', 'unclear']);
    expect(
      await judgeChoice(
        clefPicking('option_4'),
        transport,
        'no idea honestly',
        undefined,
        limits(),
      ),
    ).toMatchObject({ status: 'accepted', picked: [3] });
  });

  it("keeps a checkbox's None on its own: picked with others it is unclear", async () => {
    expect(judgeLiterally(skills, '4')).toMatchObject({
      status: 'accepted',
      picked: [3],
    });
    expect(judgeLiterally(skills, '1, 4')).toMatchObject({
      status: 'unclear',
      candidates: ['Photos', 'None of these'],
    });
    expect(Object.keys(multiChoiceRequest(skills, 'x').questions)).toEqual([
      'option_1',
      'option_2',
      'option_3',
      'option_4',
    ]);
    const both: ClefRunner = async (request) => ({
      model: 'clef',
      answers: Object.fromEntries(
        Object.keys(request.questions).map((id) => [
          id,
          {
            type: 'noul' as const,
            noul: id === 'option_1' || id === 'option_4' ? 0.9 : 0.01,
          },
        ]),
      ),
    });
    expect(
      (
        await judgeChoice(
          both,
          skills,
          'photos, or nothing',
          undefined,
          limits(),
        )
      ).status,
    ).toBe('unclear');
  });

  it('reads a typed number as an option only by its text when the options are numbers', () => {
    expect(judgeLiterally(people, '10')).toMatchObject({
      status: 'accepted',
      picked: [1],
    });
    // "2" is not the second option here: no option reads "2".
    expect(judgeLiterally(people, '2').status).toBe('unclear');
    expect(judgeLiterally(country, '2')).toMatchObject({ picked: [1] });
  });

  it('gives Clef at most its own few seconds, even with the whole tool budget left', async () => {
    vi.useFakeTimers();
    const late: ClefRunner = () => new Promise(() => undefined);
    const pending = judgeChoice(late, country, 'Maseru', undefined, {
      signal: new AbortController().signal,
      deadline: Date.now() + 20_000,
    });
    await vi.advanceTimersByTimeAsync(CLEF_TIMEOUT_MS + 10);
    expect(await pending).toMatchObject({
      status: 'unclear',
      clefFailed: true,
    });
    expect(CLEF_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
