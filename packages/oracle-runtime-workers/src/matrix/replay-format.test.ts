import { describe, expect, it } from 'vitest';
import { formatReplay } from './replay-format';

describe('formatReplay (Node formatMsg parity)', () => {
  it('prefixes the user message with **You:** and renders markdown', () => {
    const out = formatReplay({ message: 'hello *there*', isOracle: false });
    expect(out.body).toBe('**You:**\nhello *there*');
    expect(out.formattedBody).toContain('<strong>You:</strong>');
    expect(out.formattedBody).toContain('<em>there</em>');
  });

  it('prefixes the reply with the oracle name', () => {
    const out = formatReplay({
      message: 'Sure.',
      isOracle: true,
      oracleName: 'QiForge',
    });
    expect(out.body).toBe('**QiForge:**\nSure.');
    expect(out.formattedBody).toContain('<strong>QiForge:</strong>');
  });

  it('honours disablePrefix', () => {
    expect(
      formatReplay({ message: 'raw', isOracle: true, disablePrefix: true })
        .body,
    ).toBe('raw');
  });
});
