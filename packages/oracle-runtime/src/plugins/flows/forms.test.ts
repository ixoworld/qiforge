import { describe, expect, it } from 'vitest';
import { flowSpecToBaseUcan, stepIdToBlockId } from './translator.js';
import { setStepProps } from './edit.js';
import { describeForm, fillForm, setFormSchema } from './forms.js';
import { hydrateFlowDoc, someActionType } from './test-support.js';
import type { Doc as YDoc } from 'yjs';

const SURVEY = JSON.stringify({
  pages: [
    {
      elements: [
        {
          name: 'color',
          type: 'dropdown',
          title: 'Pick a color',
          isRequired: true,
          choices: [
            { value: 'r', text: 'Red' },
            { value: 'g', text: 'Green' },
          ],
        },
        { name: 'note', type: 'text', title: 'A note' },
      ],
    },
  ],
});

function formFlowDoc(): YDoc {
  const action = someActionType();
  const doc = hydrateFlowDoc(
    flowSpecToBaseUcan(
      { title: 'Form flow', steps: [{ id: 'form', action }] },
      { flowId: 'f' },
    ),
  );
  setStepProps(doc, 'form', { surveySchema: SURVEY });
  return doc;
}

function runtimeOf(doc: YDoc, stepId: string): Record<string, unknown> {
  const value = doc.getMap('runtime').get(stepIdToBlockId(stepId));
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

describe('describe_form', () => {
  it('returns the questions with their allowed choice values', () => {
    const doc = formFlowDoc();
    const { questions } = describeForm(doc, 'form');
    const color = questions.find((q) => q.name === 'color');
    expect(color?.isRequired).toBe(true);
    expect(color?.choices?.map((c) => c.value)).toEqual(['r', 'g']);
    expect(questions.find((q) => q.name === 'note')).toBeDefined();
  });

  it('errors when the step has no form', () => {
    const action = someActionType();
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        { title: 'No form', steps: [{ id: 'plain', action }] },
        { flowId: 'f' },
      ),
    );
    expect(() => describeForm(doc, 'plain')).toThrowError(/no form/i);
  });
});

describe('set_form_schema (authoring the questions)', () => {
  it('authors questions into the step that describe_form then reads back', () => {
    const action = someActionType();
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        { title: 'Form flow', steps: [{ id: 'form', action }] },
        { flowId: 'f' },
      ),
    );

    const result = setFormSchema(doc, 'room', 'form', [
      { name: 'did', label: 'Your DID', required: true },
      { name: 'role', type: 'dropdown', choices: ['admin', 'member'] },
    ]);
    expect(result.questionCount).toBe(2);

    // The step now has a fillable form (written to inputs.surveySchema).
    const { questions } = describeForm(doc, 'form');
    expect(questions.map((q) => q.name).sort()).toEqual(['did', 'role']);
    expect(questions.find((q) => q.name === 'did')?.isRequired).toBe(true);
    const role = questions.find((q) => q.name === 'role');
    expect(role?.type).toBe('dropdown');
    expect(role?.choices?.map((c) => c.value)).toEqual(['admin', 'member']);
  });
});

describe('fill_form', () => {
  it('writes accepted answers to the runtime and does NOT mark the step complete', () => {
    const doc = formFlowDoc();
    const result = fillForm(doc, 'form', { color: 'r', note: 'hello' });

    expect(result.applied.sort()).toEqual(['color', 'note']);
    expect(result.rejected).toEqual([]);

    const runtime = runtimeOf(doc, 'form');
    const output = runtime.output as
      | { form?: { answers?: string } }
      | undefined;
    expect(JSON.parse(output!.form!.answers!)).toEqual({
      color: 'r',
      note: 'hello',
    });
    // Crucially: filling is not submitting — the step is never marked completed.
    expect(runtime.state).not.toBe('completed');
    expect(runtime.state).toBe('idle');
  });

  it('rejects an invalid choice value and an unknown question', () => {
    const doc = formFlowDoc();
    const result = fillForm(doc, 'form', { color: 'purple', bogus: 1 });
    expect(result.applied).toEqual([]);
    expect(result.rejected.map((r) => r.name).sort()).toEqual([
      'bogus',
      'color',
    ]);
    expect(result.validation.ok).toBe(false);
  });

  it('merges with existing answers by default', () => {
    const doc = formFlowDoc();
    fillForm(doc, 'form', { note: 'first' });
    fillForm(doc, 'form', { color: 'g' });
    const output = runtimeOf(doc, 'form').output as {
      form?: { answers?: string };
    };
    expect(JSON.parse(output.form!.answers!)).toEqual({
      note: 'first',
      color: 'g',
    });
  });
});
