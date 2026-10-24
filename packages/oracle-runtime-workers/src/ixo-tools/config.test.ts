import { catalog } from '@ixo/agent-tools';
import { describe, expect, it } from 'vitest';
import { ixoToolsConfigSchema, readIxoToolsConfig } from './config';

const valid = {
  IXO_TOOLS_SUBSCRIPTIONS_ORIGIN: 'https://subscriptions.test',
  IXO_TOOLS_MEMORY_ORIGIN: 'https://memory.test',
  IXO_TOOLS_VFS_ORIGIN: 'https://vfs.test',
  IXO_TOOLS_YELLOWCARD_ORIGIN: 'https://yellowcard.test',
  IXO_TOOLS_UCAN_STORE_ORIGIN: 'https://store.test',
};
describe('explicit native deployment configuration', () => {
  it('requires all five fixed HTTPS origins', () => {
    for (const key of Object.keys(valid))
      expect(
        ixoToolsConfigSchema.safeParse({ ...valid, [key]: undefined }).success,
      ).toBe(false);
    for (const origin of [
      'http://memory.test',
      'https://user:password@memory.test',
      'https://memory.test/path',
      'https://memory.test?token=x',
      'https://memory.test#fragment',
      'https://memory.test/',
    ])
      expect(
        ixoToolsConfigSchema.safeParse({
          ...valid,
          IXO_TOOLS_MEMORY_ORIGIN: origin,
        }).success,
      ).toBe(false);
  });
  it('defaults to the whole catalog and public oracle knowledge with idempotent validated config reads', () => {
    const config = readIxoToolsConfig(ixoToolsConfigSchema.parse(valid));
    expect(config.enabledTools).toEqual(catalog.map(({ name }) => name));
    expect(config.oracleKnowledge).toBe('public');
  });
  it('allows only catalog names and an empty reduction', () => {
    expect(
      readIxoToolsConfig({ ...valid, IXO_TOOLS_MODULES: '' }).enabledTools,
    ).toEqual([]);
    expect(
      readIxoToolsConfig({
        ...valid,
        IXO_TOOLS_MODULES: 'ixo_account_get, ixo_concept_get',
      }).enabledTools,
    ).toEqual(['ixo_account_get', 'ixo_concept_get']);
    expect(
      ixoToolsConfigSchema.safeParse({
        ...valid,
        IXO_TOOLS_MODULES: 'ixo_account_get,unknown',
      }).success,
    ).toBe(false);
    expect(
      ixoToolsConfigSchema.safeParse({
        ...valid,
        IXO_TOOLS_ORACLE_KNOWLEDGE: 'inherit',
      }).success,
    ).toBe(false);
  });
});
