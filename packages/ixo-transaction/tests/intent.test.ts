import { describe, expect, it } from 'vitest';

import { classifyIntent, parseSlashCommand } from '../src/intent.js';

describe('intent routing', () => {
  it.each([
    ['/ixo entity create', 'MsgCreateEntity'],
    ['/ixo entity transfer', 'MsgTransferEntity'],
    ['/ixo iid add-linked-resource', 'MsgAddLinkedResource'],
    ['/ixo claims submit', 'MsgSubmitClaim'],
    ['/ixo token retire', 'MsgRetireToken'],
    ['/ixo names register', 'MsgRegisterName'],
    ['/ixo smart-account add-authenticator', 'MsgAddAuthenticator'],
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
});
