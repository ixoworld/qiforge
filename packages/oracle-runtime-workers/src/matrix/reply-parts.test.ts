import { describe, expect, it } from 'vitest';
import type { ReplyPart } from '../delivery/types';
import { replyTxnId } from './inbox-store';
import { replyPartContent, replyPartTxnId } from './reply-parts';

describe('Matrix reply parts', () => {
  it('renders a text part as HTML with no name prefix', () => {
    const out = replyPartContent({
      partId: 'p1',
      kind: 'text',
      text: 'Booked **3** slots.',
    });
    expect(out.body).toBe('Booked **3** slots.');
    expect(out.formattedBody).toContain('<strong>3</strong>');
  });

  it('renders an artefact as its title and a link, escaped', () => {
    const out = replyPartContent({
      partId: 'p2',
      kind: 'artifact',
      artifact: {
        artifactId: 'a'.repeat(32),
        title: 'Q3 <plan> & "notes"',
        url: 'https://oracle.test/a/aaa#k=x&y',
        mime: 'text/markdown',
        bytes: 10,
        expiresAt: '2026-10-25T09:00:00.000Z',
      },
    });
    expect(out.body).toBe(
      'Q3 <plan> & "notes"\nhttps://oracle.test/a/aaa#k=x&y',
    );
    expect(out.formattedBody).toBe(
      '<p><strong>Q3 &lt;plan&gt; &amp; &quot;notes&quot;</strong><br><a href="https://oracle.test/a/aaa#k=x&amp;y">Open document</a></p>',
    );
  });

  it('gives each part of a turn its own stable transaction id', () => {
    const part = (partId: string): ReplyPart => ({
      partId,
      kind: 'text',
      text: 'x',
    });
    const first = replyPartTxnId('$ev/1+x', part('p1'));
    expect(first).toBe('reply-$ev_1-x-p1');
    expect(replyPartTxnId('$ev/1+x', part('p1'))).toBe(first);
    expect(replyPartTxnId('$ev/1+x', part('p2'))).not.toBe(first);
    expect(first).not.toBe(replyTxnId('$ev/1+x'));
  });
});
