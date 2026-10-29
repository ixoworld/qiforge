import { describe, expect, it } from 'vitest';
import climatePlan from './fixtures/form-846-vct.json';
import surveyRegistration from './fixtures/form-13472-bco.json';
import treePlanting from './fixtures/form-8724-vct.json';
import {
  addSectionItem,
  encodeGeohash,
  fileAccepted,
  formErrors,
  gridCell,
  nextStep,
  openModel,
  parsePin,
  sectionBelowMinimum,
  setAnswer,
  visibleQuestions,
} from './engine';

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
