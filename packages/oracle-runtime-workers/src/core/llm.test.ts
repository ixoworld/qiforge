import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_ID,
  getModelCapabilities,
  listModelCatalog,
  MODEL_CATALOG,
  MODEL_INPUT_CAPS,
  OPENROUTER_MODEL_MAP,
} from './llm';

describe('MODEL_CATALOG', () => {
  const ids = MODEL_CATALOG.map((entry) => entry.id);

  it('has one entry per id, and the default model among them', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_MODEL_ID);
    expect(OPENROUTER_MODEL_MAP.main).toBe(DEFAULT_MODEL_ID);
  });

  it('flags exactly one listing item as the default, under its own label', () => {
    const listing = listModelCatalog(undefined);
    const defaults = listing.models.filter((m) => m.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({
      id: DEFAULT_MODEL_ID,
      label: 'GPT-5.6 Luna',
    });
    expect(listing.default).toBe(DEFAULT_MODEL_ID);
    // The "GPT-5.4 Nano" option runs GPT-5.4 Nano.
    expect(listing.models.find((m) => m.label === 'GPT-5.4 Nano')?.id).toBe(
      'openai/gpt-5.4-nano',
    );
  });

  it('keys every id-keyed table by catalog ids, and covers every catalog id', () => {
    expect(Object.keys(MODEL_INPUT_CAPS).sort()).toEqual([...ids].sort());
    for (const id of ids)
      expect(getModelCapabilities(id)).toBe(MODEL_INPUT_CAPS[id]);
    // A catalog entry that says it reads images accepts image input.
    for (const entry of MODEL_CATALOG)
      expect(getModelCapabilities(entry.id).image).toBe(entry.vision);
  });
});
