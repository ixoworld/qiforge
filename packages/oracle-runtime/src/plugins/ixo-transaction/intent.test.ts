import { describe, expect, it } from 'vitest';

import { findMessageByRoute, MESSAGE_CATALOG } from './catalog.js';
import { classifyIntent, parseSlashCommand, resolveIntent } from './intent.js';

describe('intent routing', () => {
  it('parses a slash command to a canonical Msg', () => {
    const intent = parseSlashCommand('/ixo entity create');
    expect(intent).toMatchObject({
      source: 'slash-command',
      module: 'entity',
      action: 'create',
      messageName: 'MsgCreateEntity',
      typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity',
      confidence: 1,
    });
  });

  it('classifies natural language to entity create', () => {
    const intent = classifyIntent('I want to create a new domain');
    expect(intent).toMatchObject({
      module: 'entity',
      action: 'create',
      messageName: 'MsgCreateEntity',
    });
    expect(intent.source).toBe('natural-language');
  });

  it('resolves a typeUrl directly', () => {
    const intent = classifyIntent('/ixo.token.v1beta1.MsgRetireToken');
    expect(intent).toMatchObject({
      source: 'type-url',
      module: 'token',
      action: 'retire',
      messageName: 'MsgRetireToken',
    });
  });

  it('normalizes module/action aliases via resolveIntent', () => {
    const intent = resolveIntent({ messageType: 'domain', action: 'create' });
    expect(intent.typeUrl).toBe('/ixo.entity.v1beta1.MsgCreateEntity');
    expect(intent.source).toBe('explicit-route');
  });

  it('throws an informative error on an ambiguous prompt', () => {
    expect(() => classifyIntent('do the thing with my account')).toThrow();
  });

  it('rejects deferred modules — names is not in v1', () => {
    expect(() => parseSlashCommand('/ixo names register')).toThrow(
      /Unsupported IXO transaction route/,
    );
    expect(findMessageByRoute('names', 'register')).toBeUndefined();
  });

  it('every catalog route resolves back to itself', () => {
    for (const spec of MESSAGE_CATALOG) {
      const intent = resolveIntent({ typeUrl: spec.typeUrl });
      expect(intent.typeUrl).toBe(spec.typeUrl);
      expect(intent.messageName).toBe(spec.messageName);
    }
  });
});
