import { describe, expect, it } from 'vitest';

import {
  classifyIntent,
  parseSlashCommand,
  resolveIntent,
} from '../src/intent.js';

describe('intent routing', () => {
  it.each([
    ['/ixo entity create', 'MsgCreateEntity'],
    ['/ixo entity transfer', 'MsgTransferEntity'],
    ['/ixo iid add-linked-resource', 'MsgAddLinkedResource'],
    ['/ixo claims submit', 'MsgSubmitClaim'],
    ['/ixo token retire', 'MsgRetireToken'],
    ['/ixo smart-account add-authenticator', 'MsgAddAuthenticator'],
    ['/ixo claims update-collection-quota', 'MsgUpdateCollectionQuota'],
    ['/IXO Domain Create', 'MsgCreateEntity'],
    ['/ixo credits retire', 'MsgRetireToken'],
    ['/ixo smartaccount add_authenticator', 'MsgAddAuthenticator'],
  ])('routes %s', (command, messageName) => {
    expect(parseSlashCommand(command).messageName).toBe(messageName);
  });

  it('normalizes natural language for creating a domain', () => {
    expect(classifyIntent('I want to create a new domain').messageName).toBe(
      'MsgCreateEntity',
    );
  });

  it('normalizes create entity typos', () => {
    expect(classifyIntent('megCreateEntity').messageName).toBe(
      'MsgCreateEntity',
    );
    expect(classifyIntent('msgCreateEntity').messageName).toBe(
      'MsgCreateEntity',
    );
  });

  it('rejects malformed slash commands', () => {
    expect(() => parseSlashCommand('/ixo entity')).toThrow(/Slash command/);
  });

  it('resolves a Msg typeUrl before treating a leading slash as a command', () => {
    expect(classifyIntent('/ixo.token.v1beta1.MsgRetireToken')).toMatchObject({
      source: 'type-url',
      messageName: 'MsgRetireToken',
      confidence: 1,
    });
  });

  it.each([
    ['retire 10 credits from my batch', 'MsgRetireToken'],
    ['please submit my claim for collection 4', 'MsgSubmitClaim'],
    ['transfer ownership of this entity', 'MsgTransferEntity'],
  ])('routes natural language %j', (input, messageName) => {
    expect(classifyIntent(input)).toMatchObject({
      source: 'natural-language',
      messageName,
    });
  });

  it('says why a deferred or query-only module cannot be routed', () => {
    expect(() => parseSlashCommand('/ixo names register')).toThrow(
      /The names module is not supported yet/,
    );
    expect(() => parseSlashCommand('/ixo name register')).toThrow(
      /The names module is not supported yet/,
    );
    expect(() => resolveIntent({ messageType: 'bond', action: 'buy' })).toThrow(
      /The bonds module is not supported yet/,
    );
    expect(() => parseSlashCommand('/ixo epochs tick')).toThrow(
      /The epochs module has no user transactions/,
    );
    expect(() => parseSlashCommand('/ixo entity explode')).toThrow(
      /Unsupported IXO transaction route: \/ixo entity explode/,
    );
  });

  it('reports every route a request fits instead of taking the first rule', () => {
    expect(() =>
      classifyIntent('transfer my credits to the domain account'),
    ).toThrow(
      'Ambiguous IXO transaction intent. Candidate routes: /ixo entity transfer, /ixo token transfer',
    );
  });

  it('refuses a typeUrl of a deferred module by name', () => {
    expect(() => classifyIntent('/ixo.bonds.v1beta1.MsgBuy')).toThrow(
      'The bonds module is not supported yet: /ixo.bonds.v1beta1.MsgBuy cannot be prepared for signing',
    );
    expect(() =>
      resolveIntent({ typeUrl: '/ixo.names.v1beta1.MsgRegisterName' }),
    ).toThrow(/The names module is not supported yet/);
    expect(() => classifyIntent('/ixo.token.v1beta1.MsgNotReal')).toThrow(
      'Unsupported IXO transaction typeUrl: /ixo.token.v1beta1.MsgNotReal',
    );
  });

  it('refuses a prompt it cannot classify instead of guessing', () => {
    expect(() => classifyIntent('what is the weather')).toThrow(
      /Unable to identify an IXO transaction type/,
    );
  });
});
