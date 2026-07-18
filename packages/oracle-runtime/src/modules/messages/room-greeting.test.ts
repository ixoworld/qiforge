import { describe, expect, it } from 'vitest';
import { composeGreeting } from './room-greeting.js';

describe('composeGreeting', () => {
  it('greets a DM with name, description, and the concierge offer', () => {
    const msg = composeGreeting({
      oracleName: 'Guru',
      description: 'Your guide to the IXO ecosystem.',
      isDirect: true,
    });

    expect(msg).toContain("I'm Guru — Your guide to the IXO ecosystem");
    expect(msg).toContain('human support');
    expect(msg).toContain('authorize');
    expect(msg).not.toContain('Mention me');
  });

  it('greets a group room with the mention-to-engage rule', () => {
    const msg = composeGreeting({
      oracleName: 'Guru',
      description: 'Your guide.',
      isDirect: false,
    });

    expect(msg).toContain('Mention me (@Guru)');
    expect(msg).toContain('I stay quiet otherwise');
  });

  it('omits the description clause when the description is empty', () => {
    const msg = composeGreeting({
      oracleName: 'Guru',
      description: '   ',
      isDirect: true,
    });

    expect(msg).toContain("I'm Guru.");
    expect(msg).not.toContain("I'm Guru —");
  });

  it('strips a trailing period from the description to avoid double punctuation', () => {
    const msg = composeGreeting({
      oracleName: 'Guru',
      description: 'A helpful oracle.',
      isDirect: true,
    });

    expect(msg).toContain('A helpful oracle.');
    expect(msg).not.toContain('A helpful oracle..');
  });
});
