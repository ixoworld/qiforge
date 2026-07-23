import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import type { PluginManifest } from '../../plugin-api/types.js';
import { makeBuildCtx } from '../../registries/test-fixtures.js';
import {
  deriveManifestFromCard,
  loadLocalAgentCard,
  type LocalAgentCard,
} from './local-card.js';
import { OraclePaymentsPlugin } from './oracle-payments.plugin.js';
import { DisplayCardSchema } from './types.js';
import {
  LOCAL_CARD_PATH,
  makeCardDocument,
  makeCardService,
  ORACLE_ENTITY_DID,
} from './__test-fixtures__/oracle-payments-fixtures.js';

describe('loadLocalAgentCard', () => {
  it('loads and validates the on-disk fixture card', () => {
    const card = loadLocalAgentCard(LOCAL_CARD_PATH);
    expect(card.subjectDid).toBe(ORACLE_ENTITY_DID);
    expect(card.name).toBe('Tax Oracle');
    expect(card.description).toBe('Files tax reports');
    expect(card.services.map((s) => s.id)).toEqual([
      'tax-report',
      'quick-estimate',
    ]);
    expect(card.services[0]?.price.amount).toBe(20);
  });

  it('stays in sync with makeCardDocument (fixture parity)', () => {
    const card = loadLocalAgentCard(LOCAL_CARD_PATH);
    const parsed = DisplayCardSchema.parse(makeCardDocument());
    expect(card.name).toBe(parsed.credentialSubject.name);
    expect(card.services).toEqual(parsed.credentialSubject.services);
  });

  it('throws with the offending path when the file is missing', () => {
    const missing = join(
      mkdtempSync(join(tmpdir(), 'oracle-card-')),
      'nope.json',
    );
    expect(() => loadLocalAgentCard(missing)).toThrow(missing);
  });

  it('throws when the file is not valid JSON', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'oracle-card-')), 'bad.json');
    writeFileSync(path, '{ not json');
    expect(() => loadLocalAgentCard(path)).toThrow(/not valid JSON/);
  });

  it('throws when the JSON is the wrong shape (empty services)', () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'oracle-card-')),
      'shape.json',
    );
    writeFileSync(
      path,
      JSON.stringify({
        credentialSubject: { id: ORACLE_ENTITY_DID, name: 'X', services: [] },
      }),
    );
    expect(() => loadLocalAgentCard(path)).toThrow(/not a valid agent card/);
  });
});

describe('deriveManifestFromCard', () => {
  const base: PluginManifest = {
    title: 'Oracle Payments',
    summary: 'Base summary.',
    whenToUse: ['first base line', 'second base line'],
    whenNotToUse: ['not this'],
    examples: [
      {
        user: 'hire me',
        thought: 't',
        tool: 'show_contract',
        args: { serviceId: 'tax-report' },
      },
      { user: 'list', tool: 'list_services' },
    ],
    tags: ['payments'],
    category: 'ui',
    visibility: 'always',
  };

  const card: LocalAgentCard = {
    subjectDid: ORACLE_ENTITY_DID,
    name: 'Tax Oracle',
    description: 'Files tax reports',
    services: [
      {
        id: 'alpha',
        name: 'Alpha',
        description: 'the first service',
        price: { amount: 12, currency: 'USDC' },
        deliverables: 'A PDF',
      },
      {
        id: 'freebie',
        name: 'Freebie',
        price: { amount: 0 },
        deliverables: 'A tip',
      },
    ],
  };

  it('summary carries the card name, each service name + price, and the base summary', () => {
    const m = deriveManifestFromCard(base, card);
    expect(m.summary).toContain('Tax Oracle');
    expect(m.summary).toContain('Alpha (12 USDC)');
    expect(m.summary).toContain('Freebie (free)');
    expect(m.summary).toContain(base.summary);
  });

  it('appends exactly one whenToUse line per service and keeps the base lines first', () => {
    const m = deriveManifestFromCard(base, card);
    expect(m.whenToUse).toHaveLength(
      base.whenToUse.length + card.services.length,
    );
    expect(m.whenToUse.slice(0, base.whenToUse.length)).toEqual(base.whenToUse);
    expect(m.whenToUse.some((l) => l.includes('Alpha'))).toBe(true);
    expect(m.whenToUse.some((l) => l.includes('Freebie'))).toBe(true);
  });

  it('renders a zero-priced service as "free"', () => {
    const m = deriveManifestFromCard(base, card);
    const freeLine = m.whenToUse.find((l) => l.includes('Freebie'));
    expect(freeLine).toContain('free');
    expect(freeLine).not.toContain('0 USDC');
  });

  it('retargets the show_contract example to the first service id', () => {
    const m = deriveManifestFromCard(base, card);
    const showContract = m.examples?.find((e) => e.tool === 'show_contract');
    expect(showContract?.args).toEqual({ serviceId: 'alpha' });
    const listServices = m.examples?.find((e) => e.tool === 'list_services');
    expect(listServices?.args).toBeUndefined();
  });

  it('does not mutate the base manifest', () => {
    const beforeWhenToUse = [...base.whenToUse];
    const beforeSummary = base.summary;
    const beforeArgs = base.examples?.[0]?.args;
    deriveManifestFromCard(base, card);
    expect(base.whenToUse).toEqual(beforeWhenToUse);
    expect(base.summary).toBe(beforeSummary);
    expect(base.examples?.[0]?.args).toBe(beforeArgs);
    expect(base.examples?.[0]?.args).toEqual({ serviceId: 'tax-report' });
  });
});

describe('OraclePaymentsPlugin — get manifest', () => {
  const original = process.env.AGENT_CARD_PATH;
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_CARD_PATH;
    else process.env.AGENT_CARD_PATH = original;
  });

  it('returns the static base manifest when AGENT_CARD_PATH is unset', () => {
    delete process.env.AGENT_CARD_PATH;
    const m = new OraclePaymentsPlugin().manifest;
    expect(m.title).toBe('Oracle Payments');
    expect(m.summary).not.toContain('Paid services:');
  });

  it('derives the manifest from the local card when AGENT_CARD_PATH is set', () => {
    delete process.env.AGENT_CARD_PATH;
    const baseLen = new OraclePaymentsPlugin().manifest.whenToUse.length;

    process.env.AGENT_CARD_PATH = LOCAL_CARD_PATH;
    const m = new OraclePaymentsPlugin().manifest;
    expect(m.summary).toContain('Tax Oracle');
    expect(m.summary).toContain('Tax report (20 USDC)');
    expect(m.summary).toContain('Quick estimate (5 USDC)');
    expect(m.whenToUse).toHaveLength(baseLen + 2);
    const showContract = m.examples?.find((e) => e.tool === 'show_contract');
    expect(showContract?.args).toEqual({ serviceId: 'tax-report' });
    expect(validateManifest(m, 'oracle-payments').valid).toBe(true);
  });
});

describe('OraclePaymentsPlugin — getNestModules local card seeding', () => {
  const original = process.env.AGENT_CARD_PATH;
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_CARD_PATH;
    else process.env.AGENT_CARD_PATH = original;
  });

  it('seeds the AgentCardService when the card subject matches ORACLE_ENTITY_DID', () => {
    process.env.AGENT_CARD_PATH = LOCAL_CARD_PATH;
    const agentCard = makeCardService();
    const setLocalSeed = vi.spyOn(agentCard, 'setLocalSeed');
    const plugin = new OraclePaymentsPlugin({ agentCard });

    const modules = plugin.getNestModules(
      makeBuildCtx({ config: { ORACLE_ENTITY_DID } }),
    );

    expect(setLocalSeed).toHaveBeenCalledTimes(1);
    expect(setLocalSeed).toHaveBeenCalledWith({
      oracleEntityDid: ORACLE_ENTITY_DID,
      cardProof: '',
      services: loadLocalAgentCard(LOCAL_CARD_PATH).services,
    });
    expect(modules).toHaveLength(1);
  });

  it('throws a loud boot error when the card subject does not match ORACLE_ENTITY_DID', () => {
    process.env.AGENT_CARD_PATH = LOCAL_CARD_PATH;
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    expect(() =>
      plugin.getNestModules(
        makeBuildCtx({
          config: { ORACLE_ENTITY_DID: 'did:ixo:entity:someone-else' },
        }),
      ),
    ).toThrow(/someone-else/);
  });

  it('does not seed when AGENT_CARD_PATH is unset', () => {
    delete process.env.AGENT_CARD_PATH;
    const agentCard = makeCardService();
    const setLocalSeed = vi.spyOn(agentCard, 'setLocalSeed');
    const plugin = new OraclePaymentsPlugin({ agentCard });
    plugin.getNestModules(makeBuildCtx({ config: { ORACLE_ENTITY_DID } }));
    expect(setLocalSeed).not.toHaveBeenCalled();
  });
});
