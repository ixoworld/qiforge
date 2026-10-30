import { describe, expect, it } from 'vitest';
import climatePlan from './fixtures/form-846-vct.json';
import surveyRegistration from './fixtures/form-13472-bco.json';
import treePlanting from './fixtures/form-8724-vct.json';
import {
  addSectionItem,
  asChoiceQuestion,
  clearHiddenAnswers,
  dataOf,
  encodeGeohash,
  fileAccepted,
  formErrors,
  gridCell,
  nextStep,
  openModel,
  parseNumber,
  parsePin,
  sectionBelowMinimum,
  setAnswer,
  typedAnswer,
  viewAt,
  visibleQuestions,
  type FormQuestion,
} from './engine';
import { buildClaimOperation, readBack } from './submission';

const progress = { skipped: [], closedSections: [] };

/** Sets an answer that must be accepted. */
function answer(
  model: ReturnType<typeof openModel>,
  path: string,
  value: unknown,
) {
  const result = setAnswer(model, path, value);
  if (!result.ok) throw new Error(result.errors.join('; '));
}

describe('the form engine on real Yoma forms', () => {
  it('asks the first question of the tree planting claim and reads its map and file questions', () => {
    const model = openModel(treePlanting, {});
    expect(nextStep(model, progress)).toMatchObject({
      kind: 'question',
      question: {
        path: 'schema:addressLocality',
        input: 'text',
        required: true,
      },
    });
    const views = visibleQuestions(model);
    expect(views.find((v) => v.name === 'geo:location')).toMatchObject({
      input: 'location',
    });
    expect(views.find((v) => v.name === 'ixo:photoBefore')).toMatchObject({
      input: 'file',
      acceptedTypes: 'image/*',
    });
    expect(
      views.find((v) => v.name === 'ixo:recipientSignature'),
    ).toMatchObject({ input: 'web-only' });
  });

  it('follows a show-if rule: the residency question decides what comes next', () => {
    const model = openModel(surveyRegistration, {});
    const names = () => visibleQuestions(model).map((v) => v.name);
    expect(names()).not.toContain('other_country');
    answer(model, 'first_name', 'Lebo');
    answer(model, 'residency_sa', 'no');
    expect(names()).toContain('other_country');
  });

  it('works through a repeating section item by item, keeping the data shape the web form keeps', () => {
    const model = openModel(climatePlan, {});
    // The form starts the member list with items of its own: the first question is in item 1.
    const step = nextStep(model, progress);
    expect(step).toMatchObject({
      kind: 'question',
      question: { item: { section: 'org:hasMember', number: 1 } },
    });
    answer(model, 'org:hasMember[0].schema:name', 'Thandi');
    const result = setAnswer(
      model,
      'org:hasMember[0].schema:email',
      'thandi@example.org',
    );
    // The form starts the section with its own number of empty items; the answers land in the first.
    const members = result.ok ? result.data['org:hasMember'] : undefined;
    expect(Array.isArray(members) && members[0]).toEqual({
      'schema:name': 'Thandi',
      'schema:email': 'thandi@example.org',
    });
  });

  it('holds a required repeating section to its minimum, and adds items up to its maximum', () => {
    const form = {
      question: {
        pages: [
          {
            elements: [
              {
                type: 'paneldynamic',
                name: 'shops',
                isRequired: true,
                panelCount: 0,
                maxPanelCount: 1,
                templateElements: [{ type: 'text', name: 'shop' }],
              },
            ],
          },
        ],
      },
    };
    const model = openModel(form, {});
    expect(sectionBelowMinimum(model, 'shops')).toBe(
      'This section needs at least 1 item.',
    );
    expect(formErrors(model).map((e) => e.path)).toContain('shops');
    expect(addSectionItem(model, 'shops').ok).toBe(true);
    expect(sectionBelowMinimum(model, 'shops')).toBeUndefined();
    expect(addSectionItem(model, 'shops')).toEqual({
      ok: false,
      detail: 'This section takes at most 1 items.',
    });
    expect(addSectionItem(model, 'nope')).toEqual({
      ok: false,
      detail: 'There is no repeating section "nope".',
    });
  });

  it('shows the local leader questions only when a leader was contacted', () => {
    const shown = (data: Record<string, unknown>) =>
      visibleQuestions(openModel(climatePlan, data)).some(
        (v) => v.name === 'schema:name_localLeader',
      );
    expect(shown({})).toBe(false);
    expect(shown({ 'ixo:localLeaderContacted': 'yes' })).toBe(true);
  });

  it('refuses a value the form refuses, and leaves the model as it was', () => {
    const model = openModel(climatePlan, {});
    const result = setAnswer(model, 'schema:email', 'not an email');
    expect(result.ok).toBe(false);
    expect(model.getQuestionByName('schema:email')?.isEmpty()).toBe(true);
  });

  it('says what is still missing before the form could be sent', () => {
    const errors = formErrors(
      openModel(treePlanting, { 'schema:addressLocality': 'Mfuwe' }),
    );
    expect(errors.map((e) => e.path)).toContain('schema:recipient');
    expect(errors.map((e) => e.path)).not.toContain('schema:addressLocality');
  });

  it('throws on a form with no pages, so callers can answer it on their own', () => {
    expect(() => openModel({ question: { title: 'Broken' } }, {})).toThrow();
  });
});

describe('pins and files', () => {
  it('reads the pin line the gateway writes', () => {
    expect(parsePin('📍 -26.204103, 28.047305 — Soweto, Vilakazi St')).toEqual({
      latitude: -26.204103,
      longitude: 28.047305,
      placeName: 'Soweto, Vilakazi St',
    });
    expect(parsePin('📍 -33.92, 18.42')).toEqual({
      latitude: -33.92,
      longitude: 18.42,
    });
    expect(parsePin('the shop on the corner')).toBeUndefined();
  });

  it("stores a pin as the cell Jambo stores, at the form's grid size", () => {
    const cell = gridCell(openModel(treePlanting, {}), 'geo:location', {
      latitude: -13.1,
      longitude: 31.8,
    });
    expect(cell).toMatchObject({
      latitude: -13.1,
      longitude: 31.8,
      gridPrecision: 10,
    });
    expect(cell.geoId).toBe(encodeGeohash(-13.1, 31.8, 10));
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
  });

  it('clamps a grid size outside 1–12', () => {
    const form = (gridPrecision: number) => ({
      question: {
        pages: [
          {
            elements: [
              { type: 'map-grid-selector', name: 'where', gridPrecision },
            ],
          },
        ],
      },
    });
    const at = { latitude: 1, longitude: 1 };
    expect(gridCell(openModel(form(99), {}), 'where', at).gridPrecision).toBe(
      12,
    );
    expect(gridCell(openModel(form(-3), {}), 'where', at).gridPrecision).toBe(
      1,
    );
  });

  it("matches a file against the question's accepted types", () => {
    expect(fileAccepted('image/*', 'image/jpeg', 'a.jpg')).toBe(true);
    expect(fileAccepted('image/*', 'application/pdf', 'a.pdf')).toBe(false);
    expect(
      fileAccepted('.pdf,image/png', 'application/pdf', 'contract.PDF'),
    ).toBe(true);
    expect(fileAccepted(undefined, 'video/mp4', 'v.mp4')).toBe(true);
  });
});

/** A one-page form of these elements. */
const formOf = (...elements: unknown[]) => ({
  question: { pages: [{ elements }] },
});

describe('what is read back is what is sent', () => {
  /** The 846 climate-plan claim filled up to the local leader, who was contacted. */
  function withLeader() {
    const model = openModel(climatePlan);
    answer(model, 'ixo:localLeaderContacted', 'yes');
    answer(model, 'schema:name_localLeader', 'Chief Dlamini');
    answer(model, 'schema:telephone_localLeader', '+27 71 234 5678');
    return model;
  }

  it('drops the local leader once they say no leader was contacted: from the rows and from the data alike', () => {
    const model = withLeader();
    answer(model, 'ixo:localLeaderContacted', 'no');
    // The draft still holds the leader (they come back if the answer changes back).
    expect(dataOf(model)).toMatchObject({
      'schema:name_localLeader': 'Chief Dlamini',
    });
    const built = buildClaimOperation({
      network: 'ixo mainnet',
      model,
      draft: { collectionId: '846', title: 'Climate plan', evidence: [] },
    });
    if (!built.ok) throw new Error(built.why);
    const data = JSON.parse(built.operation.data) as Record<string, unknown>;
    expect(data).not.toHaveProperty('schema:name_localLeader');
    expect(data).not.toHaveProperty('schema:telephone_localLeader');
    expect(data).toMatchObject({ 'ixo:localLeaderContacted': 'no' });
    expect(
      built.rows.some((row) => row.field === 'schema:name_localLeader'),
    ).toBe(false);
    expect(built.operation.summary).toEqual(
      built.rows.map(({ field, label, value }) => ({ field, label, value })),
    );
  });

  it('keeps the leader when they were contacted, in the rows and the data', () => {
    const model = withLeader();
    clearHiddenAnswers(model);
    expect(dataOf(model)).toMatchObject({
      'schema:name_localLeader': 'Chief Dlamini',
    });
    expect(readBack(model).rows).toContainEqual({
      field: 'schema:name_localLeader',
      label: "Local leader's name",
      value: 'Chief Dlamini',
    });
  });

  it('clears a hidden panel inside one item of a repeating section, and never asks it', () => {
    const model = openModel(
      formOf({
        type: 'paneldynamic',
        name: 'shops',
        panelCount: 1,
        templateElements: [
          { type: 'text', name: 'kind' },
          {
            type: 'panel',
            name: 'stall',
            visibleIf: "{panel.kind} = 'stall'",
            elements: [{ type: 'text', name: 'pitch' }],
          },
        ],
      }),
    );
    answer(model, 'shops[0].kind', 'stall');
    expect(visibleQuestions(model).map((v) => v.path)).toContain(
      'shops[0].pitch',
    );
    answer(model, 'shops[0].pitch', 'B12');
    answer(model, 'shops[0].kind', 'shop');
    expect(visibleQuestions(model).map((v) => v.path)).not.toContain(
      'shops[0].pitch',
    );
    expect(viewAt(model, 'shops[0].pitch')).toBeUndefined();
    clearHiddenAnswers(model);
    expect(dataOf(model).shops).toEqual([{ kind: 'shop' }]);
  });
});

describe('defaults', () => {
  const withDefault = formOf(
    { type: 'text', name: 'country', defaultValue: 'South Africa' },
    { type: 'text', name: 'town' },
  );

  it('opens a new form with its defaults, and a saved draft exactly as saved', () => {
    expect(dataOf(openModel(withDefault))).toEqual({ country: 'South Africa' });
    expect(nextStep(openModel(withDefault), progress)).toMatchObject({
      question: { path: 'town' },
    });
    // A saved draft is the whole truth: a default it does not hold stays out.
    expect(dataOf(openModel(withDefault, { town: 'Soweto' }))).toEqual({
      town: 'Soweto',
    });
  });
});

describe('typed answers', () => {
  const view = (
    input: FormQuestion['input'],
    extra: Partial<FormQuestion> = {},
  ) =>
    ({
      path: 'q',
      name: 'q',
      type: 'text',
      input,
      title: 'Q',
      required: true,
      ...extra,
    }) satisfies FormQuestion;

  it('reads dates in a few written forms and refuses anything that is not a real date', () => {
    expect(typedAnswer(view('date'), '2026-10-30', undefined)).toEqual({
      ok: true,
      value: '2026-10-30',
    });
    expect(typedAnswer(view('date'), 'x', '2026/1/5')).toEqual({
      ok: true,
      value: '2026-01-05',
    });
    expect(typedAnswer(view('date'), '2026-02-30', undefined).ok).toBe(false);
    expect(typedAnswer(view('date'), 'abc', undefined)).toMatchObject({
      ok: false,
      say: expect.stringContaining('date'),
    });
    expect(typedAnswer(view('datetime'), '2026-10-30 9:05', undefined)).toEqual(
      {
        ok: true,
        value: '2026-10-30T09:05',
      },
    );
    expect(typedAnswer(view('datetime'), '2026-10-30', undefined).ok).toBe(
      false,
    );
    expect(
      typedAnswer(view('datetime'), '2026-10-30T25:00', undefined).ok,
    ).toBe(false);
  });

  it('reads numbers as people write them, and refuses an ambiguous or non-number', () => {
    expect(parseNumber('12')).toBe(12);
    expect(parseNumber(' 1 500 ')).toBe(1500);
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber('-2.25')).toBe(-2.25);
    expect(parseNumber('1,500')).toBeUndefined();
    expect(parseNumber('abc')).toBeUndefined();
    expect(typedAnswer(view('number'), 'abc', undefined)).toMatchObject({
      ok: false,
      say: expect.stringContaining('number'),
    });
    expect(typedAnswer(view('number'), 'twelve', 12)).toEqual({
      ok: true,
      value: 12,
    });
  });

  it("holds a rating to the form's own scale", () => {
    const rating = view('rating', { rateValues: [1, 2, 3, 4, 5] });
    expect(typedAnswer(rating, '4', undefined)).toEqual({ ok: true, value: 4 });
    expect(typedAnswer(rating, '6', undefined).ok).toBe(false);
    expect(typedAnswer(rating, '2.5', undefined).ok).toBe(false);
  });

  it('gets a numeric rating scale from the form, and a worded one as a choice', () => {
    const model = openModel(
      formOf(
        { type: 'rating', name: 'stars', rateMin: 1, rateMax: 3 },
        {
          type: 'rating',
          name: 'mood',
          rateValues: [
            { value: 'sad', text: 'Sad' },
            { value: 'happy', text: 'Happy' },
          ],
        },
      ),
    );
    expect(viewAt(model, 'stars')).toMatchObject({
      input: 'rating',
      rateValues: [1, 2, 3],
    });
    expect(viewAt(model, 'mood')).toMatchObject({
      input: 'pick-one',
      options: [
        { value: 'sad', text: 'Sad' },
        { value: 'happy', text: 'Happy' },
      ],
    });
  });
});

describe('choices', () => {
  it("offers a single choice's None, Refuse and Don't know items, with the values the form stores", () => {
    const model = openModel(
      formOf({
        type: 'radiogroup',
        name: 'travel',
        choices: ['Bus', 'Taxi'],
        showNoneItem: true,
        showRefuseItem: true,
        showDontKnowItem: true,
      }),
    );
    const view = viewAt(model, 'travel')!;
    expect(view.options).toEqual([
      { value: 'Bus', text: 'Bus' },
      { value: 'Taxi', text: 'Taxi' },
      { value: 'none', text: 'None' },
      { value: 'refused', text: 'Refuse to answer' },
      { value: 'dontknow', text: "Don't know" },
    ]);
    expect(asChoiceQuestion(view).exclusive).toBeUndefined();
    answer(model, 'travel', 'none');
    expect(dataOf(model)).toEqual({ travel: 'none' });
  });

  it('tells a regular choice valued "none" from the form\'s None item, which goes on its own', () => {
    const model = openModel(
      formOf({
        type: 'checkbox',
        name: 'tools',
        choices: ['spade', { value: 'none', text: 'a tool called none' }],
        showNoneItem: true,
        noneText: 'No tools',
      }),
    );
    const view = viewAt(model, 'tools')!;
    expect(view.options?.map((o) => o.text)).toEqual([
      'spade',
      'a tool called none',
      'No tools',
    ]);
    expect(view.options?.[1]).not.toHaveProperty('exclusive');
    expect(view.options?.[2]).toMatchObject({ exclusive: true });
    expect(asChoiceQuestion(view)).toMatchObject({ exclusive: [2] });
  });

  it('stores an own "Other" answer where the form keeps it: a comment, or the value itself', () => {
    const asComment = openModel(
      formOf({
        type: 'radiogroup',
        name: 'country',
        choices: ['ZA'],
        showOtherItem: true,
      }),
    );
    expect(setAnswer(asComment, 'country', 'other', 'Malawi')).toMatchObject({
      ok: true,
      data: { country: 'other', 'country-Comment': 'Malawi' },
    });
    const inValue = openModel(
      formOf({
        type: 'radiogroup',
        name: 'country',
        choices: ['ZA'],
        showOtherItem: true,
        storeOthersAsComment: false,
      }),
    );
    expect(setAnswer(inValue, 'country', 'other', 'Malawi')).toMatchObject({
      ok: true,
      data: { country: 'Malawi' },
    });
    expect(readBack(inValue).rows).toEqual([
      { field: 'country', label: 'country', value: 'Malawi' },
    ]);
    expect(readBack(asComment).rows).toEqual([
      {
        field: 'country',
        label: 'country',
        value: 'other',
        means: 'Other (describe)',
      },
      {
        field: 'country-Comment',
        label: 'country (own answer)',
        value: 'Malawi',
      },
    ]);
  });

  it('says when a long list was cut, offering the first 60', () => {
    const model = openModel(
      formOf({
        type: 'dropdown',
        name: 'town',
        choices: Array.from({ length: 75 }, (_, i) => `Town ${i}`),
      }),
    );
    const view = viewAt(model, 'town')!;
    expect(view.options).toHaveLength(60);
    expect(view.optionsCut).toBe(75);
  });
});

describe('the order of asking', () => {
  it('asks "another item?" right after a repeating section, before what follows it', () => {
    const model = openModel(
      formOf(
        {
          type: 'paneldynamic',
          name: 'shops',
          panelCount: 1,
          templateElements: [{ type: 'text', name: 'shop' }],
        },
        { type: 'text', name: 'after' },
      ),
    );
    answer(model, 'shops[0].shop', 'Spaza');
    expect(nextStep(model, progress)).toMatchObject({
      kind: 'more',
      section: { section: 'shops', items: 1 },
    });
    expect(
      nextStep(model, { skipped: [], closedSections: ['shops'] }),
    ).toMatchObject({ kind: 'question', question: { path: 'after' } });
  });

  it('asks a skipped question again once it becomes required, and never hides that it is missing', () => {
    const model = openModel(
      formOf(
        { type: 'text', name: 'phone' },
        { type: 'boolean', name: 'callMe' },
      ),
    );
    model.getQuestionByName('phone')!.requiredIf = '{callMe} = true';
    const state = { skipped: ['phone'], closedSections: [] };
    expect(nextStep(model, state)).toMatchObject({
      question: { path: 'callMe' },
    });
    answer(model, 'callMe', true);
    expect(nextStep(model, state)).toMatchObject({
      question: { path: 'phone', required: true },
    });
    expect(formErrors(model).map((e) => e.path)).toContain('phone');
  });
});
