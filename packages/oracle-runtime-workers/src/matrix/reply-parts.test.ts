import { describe, expect, it } from 'vitest';
import { replyTxnId } from './inbox-store';
import {
  renderRoomMarkdown,
  replyPartContent,
  replyPartTxnId,
  roomReplyMessages,
} from './reply-parts';

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

  it('renders a file as its name, its caption and a link, escaped', () => {
    const out = replyPartContent({
      partId: 'p2',
      kind: 'file',
      file: {
        url: 'https://r2.example/o/a.pdf?sig=1&x=2',
        filename: 'Q3 <plan>.pdf',
        mimetype: 'application/pdf',
        caption: 'The <b>report</b>',
      },
    });
    expect(out.body).toBe(
      'The <b>report</b>\nQ3 <plan>.pdf\nhttps://r2.example/o/a.pdf?sig=1&x=2',
    );
    expect(out.formattedBody).toBe(
      '<p><strong>Q3 &lt;plan&gt;.pdf</strong><br>The &lt;b&gt;report&lt;/b&gt;<br><a href="https://r2.example/o/a.pdf?sig=1&amp;x=2">Open file</a></p>',
    );
  });

  it('posts a file part of a plan as its own message', () => {
    const plan = JSON.stringify({
      v: 1,
      parts: [
        { partId: 'p1', kind: 'text', text: 'Here.' },
        {
          partId: 'p2',
          kind: 'file',
          file: {
            url: 'https://r2.example/o/a.pdf',
            filename: 'a.pdf',
            mimetype: 'application/pdf',
          },
        },
      ],
    });
    const messages = roomReplyMessages({ text: 'Here.', plan });
    expect(messages.map((m) => m.partId)).toEqual(['p1', 'p2']);
    expect(messages[1]?.body).toBe('a.pdf\nhttps://r2.example/o/a.pdf');
  });

  it('gives each part of a turn its own stable transaction id', () => {
    const first = replyPartTxnId('$ev/1+x', 'p1');
    expect(first).toBe('reply-$ev_1-x-p1');
    expect(replyPartTxnId('$ev/1+x', 'p1')).toBe(first);
    expect(replyPartTxnId('$ev/1+x', 'p2')).not.toBe(first);
    expect(first).not.toBe(replyTxnId('$ev/1+x'));
  });

  it('posts a reply without a plan as the plain text alone, as before chat delivery', () => {
    const text = 'Use `<div>` or <b>bold</b>.\n\n<script>alert(1)</script>';
    expect(roomReplyMessages({ text })).toEqual([{ body: text }]);
    expect(roomReplyMessages({ text: '  \n' })).toEqual([]);
  });

  it('escapes raw HTML from the model in a chat part instead of passing it through', () => {
    const plan = JSON.stringify({
      v: 1,
      parts: [
        {
          partId: 'p1',
          kind: 'text',
          text: 'Hi <img src=x onerror=alert(1)> and `<div>`.\n\n<script>alert(1)</script>',
        },
      ],
    });
    const [message] = roomReplyMessages({ text: 'ignored', plan });
    expect(message?.partId).toBe('p1');
    expect(message?.formattedBody).not.toMatch(/<img|<script/);
    expect(message?.formattedBody).toContain(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(message?.formattedBody).toContain('&lt;script&gt;');
    expect(message?.formattedBody).toContain('<code>&lt;div&gt;</code>');
  });

  it('keeps http(s), mailto and mxc links and images; anything else is plain text', () => {
    const html = renderRoomMarkdown(
      [
        '[site](https://example.com/a?b=1) [plain](http://example.com)',
        '[mail](mailto:a@example.com) [file](mxc://ixo.test/abc)',
        '![pic](mxc://ixo.test/img) ![remote](https://example.com/p.png)',
      ].join('\n\n'),
    );
    expect(html).toContain('<a href="https://example.com/a?b=1">site</a>');
    expect(html).toContain('<a href="http://example.com">plain</a>');
    expect(html).toContain('<a href="mailto:a@example.com">mail</a>');
    expect(html).toContain('<a href="mxc://ixo.test/abc">file</a>');
    expect(html).toContain('<img src="mxc://ixo.test/img" alt="pic">');
    expect(html).toContain(
      '<img src="https://example.com/p.png" alt="remote">',
    );
  });

  it('renders links and images with another scheme, or none, as their text', () => {
    const html = renderRoomMarkdown(
      [
        '[x](javascript:alert(1))',
        '[y](JavaScript:alert(1))',
        '[z](data:text/html;base64,PHNjcmlwdD4=)',
        '[rel](/relative/path)',
        '![i](javascript:alert(1)) ![j](data:image/png;base64,AAAA)',
        '<https://ok.example>',
      ].join('\n\n'),
    );
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toContain('data:');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="/relative/path"');
    expect(html).toContain('<p>x</p>');
    expect(html).toContain('<p>rel</p>');
    expect(html).toContain('<p>i j</p>');
    // An autolink is a link like any other.
    expect(html).toContain(
      '<a href="https://ok.example">https://ok.example</a>',
    );
  });
});
