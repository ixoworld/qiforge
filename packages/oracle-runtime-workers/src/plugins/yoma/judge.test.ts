import { describe, expect, it } from 'vitest';
import type { ClefRequest, ClefResponse, ClefRunner } from './clef';
import { judgeChoice, judgeLiterally, type ChoiceQuestion } from './judge';

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
  options: ['Photos', 'Mapping', 'Surveys'],
  otherAllowed: false,
  noneText: 'None of these',
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
      picked: ['Zambia'],
      by: 'number',
    });
    expect(judgeLiterally(country, ' south africa ')).toMatchObject({
      status: 'accepted',
      picked: ['South Africa'],
    });
    expect(judgeLiterally(skills, '1, 3')).toMatchObject({
      status: 'accepted',
      picked: ['Photos', 'Surveys'],
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
      picked: ['Lesotho'],
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
      picked: ['Photos'],
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
      picked: ['Lesotho'],
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
});
