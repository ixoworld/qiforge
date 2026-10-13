/**
 * The oracle's own artefact page (`GET /a/:id`), used when no shared viewer
 * is configured. Identical for every artefact: the key arrives in the URL
 * fragment, the page fetches `/a/:id/data`, decrypts with WebCrypto and
 * renders the Markdown with DOM calls only (`textContent`, never
 * `innerHTML`), so nothing in a document can run script. Images render as
 * links: loading them would tell a third party the page was opened.
 *
 * The page script is one static string: nothing in it is built from code
 * the bundler compiled, so what the browser runs (and the CSP hash pins) is
 * exactly this text. Every pattern it runs is linear in its input; the tests
 * evaluate the parsing part of the text itself.
 */

export const VIEWER_STYLE = String.raw`
:root { --bg: #f6f7f7; --paper: #ffffff; --ink: #1c2322; --muted: #5f6b69; --line: #dfe4e2; --accent: #0e6b63; --code: #eef2f1; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1413; --paper: #171f1e; --ink: #e2e8e6; --muted: #98a4a1; --line: #2b3533; --accent: #5bbdb2; --code: #1f2a28; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.62 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 28px 18px 64px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; margin-bottom: 18px; }
.from { font-size: 0.82rem; color: var(--muted); letter-spacing: 0.02em; }
.actions { display: flex; gap: 8px; }
button, .download { font: inherit; font-size: 0.85rem; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--paper); color: var(--ink); cursor: pointer; text-decoration: none; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
article { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 24px 22px; overflow-wrap: anywhere; }
article h1, article h2, article h3, article h4 { line-height: 1.25; margin: 1.4em 0 0.5em; }
article h1:first-child, article h2:first-child, article p:first-child { margin-top: 0; }
article h1 { font-size: 1.6rem; } article h2 { font-size: 1.3rem; } article h3 { font-size: 1.1rem; }
article p, article ul, article ol, article blockquote, article pre, .table { margin: 0 0 1em; }
article a { color: var(--accent); }
article code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em; background: var(--code); padding: 0.1em 0.35em; border-radius: 4px; }
article pre { background: var(--code); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
article pre code { background: none; padding: 0; }
article blockquote { border-left: 3px solid var(--line); margin-left: 0; padding-left: 14px; color: var(--muted); }
article hr { border: none; border-top: 1px solid var(--line); margin: 1.5em 0; }
.table { overflow-x: auto; }
article table { border-collapse: collapse; width: 100%; font-size: 0.92rem; font-variant-numeric: tabular-nums; }
article th, article td { border-bottom: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
article th { font-weight: 600; }
.note { color: var(--muted); }
footer { margin-top: 16px; font-size: 0.8rem; color: var(--muted); }
`;

export const VIEWER_SCRIPT = String.raw`
(function () {
  'use strict';
  // ── Inline and block parsing: pure, linear in its input ──
  // A document is model output and may carry text shaped by anything the
  // model read, so no line may make the reader's tab backtrack for seconds:
  // every closer is found by a forward search whose start only moves on.

  // The inline constructs of a paragraph, left to right, in one pass: code
  // spans (a backtick run closed by a run of the same length), **, __, ~~,
  // *, _ (not inside a word), images, links, <https://...> and bare http(s)
  // URLs.
  function scanInline(value) {
    var tokens = [];
    var n = value.length;
    var word = /[A-Za-z0-9_]/;
    var space = /\s/;
    // Backtick runs: start, length, and per length the runs in order.
    var runStart = [];
    var runLength = [];
    var runsOfLength = {};
    var runCursor = {};
    var runAt = {};
    for (var r = 0; r < n; r++) {
      if (value.charAt(r) !== '\x60') continue;
      var length = 1;
      while (r + length < n && value.charAt(r + length) === '\x60') length++;
      runAt[r] = runStart.length;
      if (!runsOfLength[length]) {
        runsOfLength[length] = [];
        runCursor[length] = 0;
      }
      runsOfLength[length].push(runStart.length);
      runStart.push(r);
      runLength.push(length);
      r += length - 1;
    }
    // The next closer at or after the last query of each kind (-1: none).
    var nextStrong = -2;
    var nextUnder = -2;
    var nextTilde = -2;
    var nextStar = -2;
    var nextEmUnder = -2;
    var nextBracket = -2;
    var nextAngle = -2;
    var nextUrlEnd = -2;
    // The target scanned after the last ]( (every opener before it shares it).
    var targetOf = -1;
    var targetAt = 0;
    var targetEnd = -1;
    var i = 0;
    while (i < n) {
      var c = value.charAt(i);
      var after = value.charAt(i + 1);
      if (c === '\x60' && runAt[i] !== undefined) {
        var run = runAt[i];
        var k = runLength[run];
        var same = runsOfLength[k];
        while (runCursor[k] < same.length && same[runCursor[k]] <= run)
          runCursor[k]++;
        if (runCursor[k] < same.length) {
          var closer = runStart[same[runCursor[k]]];
          tokens.push({
            kind: 'code',
            start: i,
            end: closer + k,
            text: value.slice(i + k, closer),
            href: '',
          });
          i = closer + k;
          continue;
        }
        i += k;
        continue;
      }
      if ((c === '*' || c === '_' || c === '~') && after === c) {
        var pair = c + c;
        var found = c === '*' ? nextStrong : c === '_' ? nextUnder : nextTilde;
        if (found !== -1 && found < i + 3) found = value.indexOf(pair, i + 3);
        if (c === '*') nextStrong = found;
        else if (c === '_') nextUnder = found;
        else nextTilde = found;
        if (found !== -1) {
          tokens.push({
            kind: c === '~' ? 'del' : 'strong',
            start: i,
            end: found + 2,
            text: value.slice(i + 2, found),
            href: '',
          });
          i = found + 2;
          continue;
        }
      }
      if (c === '*' && i + 1 < n && after !== '*' && !space.test(after)) {
        if (nextStar !== -1 && nextStar < i + 2)
          nextStar = value.indexOf('*', i + 2);
        if (nextStar !== -1) {
          tokens.push({
            kind: 'em',
            start: i,
            end: nextStar + 1,
            text: value.slice(i + 1, nextStar),
            href: '',
          });
          i = nextStar + 1;
          continue;
        }
      }
      if (
        c === '_' &&
        i + 1 < n &&
        after !== '_' &&
        !space.test(after) &&
        (i === 0 || !word.test(value.charAt(i - 1)))
      ) {
        if (nextEmUnder !== -1 && nextEmUnder < i + 2) {
          nextEmUnder = value.indexOf('_', i + 2);
          while (
            nextEmUnder !== -1 &&
            nextEmUnder + 1 < n &&
            word.test(value.charAt(nextEmUnder + 1))
          )
            nextEmUnder = value.indexOf('_', nextEmUnder + 1);
        }
        if (nextEmUnder !== -1) {
          tokens.push({
            kind: 'em',
            start: i,
            end: nextEmUnder + 1,
            text: value.slice(i + 1, nextEmUnder),
            href: '',
          });
          i = nextEmUnder + 1;
          continue;
        }
      }
      var open = c === '[' ? i : c === '!' && after === '[' ? i + 1 : -1;
      if (open !== -1) {
        if (nextBracket !== -1 && nextBracket < open + 1)
          nextBracket = value.indexOf(']', open + 1);
        var close = nextBracket;
        var image = open !== i;
        if (
          close !== -1 &&
          (image || close > open + 1) &&
          value.charAt(close + 1) === '(' &&
          targetOf !== close
        ) {
          // The target: no spaces or parentheses, except balanced (…) pairs.
          var at = close + 2;
          for (;;) {
            var ch = value.charAt(at);
            if (at < n && ch !== '(' && ch !== ')' && !space.test(ch)) {
              at++;
              continue;
            }
            if (ch === '(') {
              var inner = at + 1;
              while (inner < n) {
                var ic = value.charAt(inner);
                if (ic === '(' || ic === ')' || space.test(ic)) break;
                inner++;
              }
              if (value.charAt(inner) === ')') {
                at = inner + 1;
                continue;
              }
            }
            break;
          }
          var end = -1;
          if (at > close + 2) {
            if (value.charAt(at) === ')') end = at + 1;
            else if (space.test(value.charAt(at))) {
              var quote = at;
              while (quote < n && space.test(value.charAt(quote))) quote++;
              if (value.charAt(quote) === '"') {
                var shut = value.indexOf('"', quote + 1);
                if (shut !== -1 && value.charAt(shut + 1) === ')') end = shut + 2;
              }
            }
          }
          targetOf = close;
          targetAt = at;
          targetEnd = end;
        }
        if (
          close !== -1 &&
          targetOf === close &&
          targetEnd !== -1 &&
          (image || close > open + 1)
        ) {
          tokens.push({
            kind: image ? 'image' : 'link',
            start: i,
            end: targetEnd,
            text: value.slice(open + 1, close),
            href: value.slice(close + 2, targetAt),
          });
          i = targetEnd;
          continue;
        }
      }
      var scheme = value.startsWith('https://', c === '<' ? i + 1 : i)
        ? 8
        : value.startsWith('http://', c === '<' ? i + 1 : i)
          ? 7
          : 0;
      if (c === '<' && scheme > 0) {
        if (nextAngle !== -1 && nextAngle < i + 1 + scheme) {
          nextAngle = i + 1 + scheme;
          while (
            nextAngle < n &&
            value.charAt(nextAngle) !== '>' &&
            !space.test(value.charAt(nextAngle))
          )
            nextAngle++;
          if (nextAngle >= n) nextAngle = -1;
        }
        if (
          nextAngle !== -1 &&
          nextAngle > i + 1 + scheme &&
          value.charAt(nextAngle) === '>'
        ) {
          var target = value.slice(i + 1, nextAngle);
          tokens.push({
            kind: 'url',
            start: i,
            end: nextAngle + 1,
            text: target,
            href: target,
          });
          i = nextAngle + 1;
          continue;
        }
      }
      if (c === 'h' && scheme > 0) {
        if (nextUrlEnd !== -1 && nextUrlEnd < i + scheme) {
          nextUrlEnd = i + scheme;
          while (nextUrlEnd < n && !/[\s<>()]/.test(value.charAt(nextUrlEnd)))
            nextUrlEnd++;
        }
        // Trailing punctuation is the sentence's, not the URL's.
        var last = nextUrlEnd - 1;
        while (last > i + scheme && /[.,;:!?'"]/.test(value.charAt(last))) last--;
        if (last > i + scheme) {
          var url = value.slice(i, last + 1);
          tokens.push({
            kind: 'url',
            start: i,
            end: last + 1,
            text: url,
            href: url,
          });
          i = last + 1;
          continue;
        }
      }
      i++;
    }
    return tokens;
  }

  // A Markdown ATX heading (## Title ##): its level and text, or null.
  function parseHeading(line) {
    var match = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (!match) return null;
    var text = match[2].trimEnd();
    // A closing run of #s is dropped when a space sets it apart (or it is
    // all there is); # C# keeps its #.
    var cut = text.length;
    while (cut > 0 && text.charAt(cut - 1) === '#') cut--;
    if (cut === 0) text = '';
    else if (cut < text.length && /[ \t]/.test(text.charAt(cut - 1)))
      text = text.slice(0, cut).trimEnd();
    return { level: match[1].length, text: text };
  }

  // The |---|:---:| line under a table's header row.
  var DIVIDER =
    /^[ \t]*(?:\|[ \t]*)?:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*(?:\|[ \t]*)?$/;
  // ── End of parsing ──
  var article = document.getElementById('doc');
  var status = document.getElementById('status');
  var actions = document.getElementById('actions');
  var footer = document.getElementById('meta');
  var TICK = '\x60';

  function el(tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function fail(message) {
    status.textContent = message;
    status.hidden = false;
    article.hidden = true;
  }
  function safeHref(href) {
    try {
      var url = new URL(href, location.href);
      return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null;
    } catch (e) {
      return null;
    }
  }
  function link(href, parent) {
    var safe = safeHref(href);
    if (!safe) return null;
    var a = el('a');
    a.href = safe;
    a.rel = 'noopener noreferrer';
    a.target = '_blank';
    parent.appendChild(a);
    return a;
  }
  function text(value, parent) {
    var lines = value.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) parent.appendChild(el('br'));
      if (lines[i]) parent.appendChild(document.createTextNode(lines[i]));
    }
  }

  function inline(value, parent) {
    var tokens = scanInline(value);
    var last = 0;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.start > last) text(value.slice(last, t.start), parent);
      last = t.end;
      if (t.kind === 'code') parent.appendChild(el('code', t.text));
      else if (t.kind === 'strong') inline(t.text, parent.appendChild(el('strong')));
      else if (t.kind === 'del') inline(t.text, parent.appendChild(el('del')));
      else if (t.kind === 'em') inline(t.text, parent.appendChild(el('em')));
      else if (t.kind === 'image') {
        var image = link(t.href, parent);
        if (image) image.textContent = 'Image: ' + (t.text || t.href);
        else text(t.text || '', parent);
      } else if (t.kind === 'link') {
        var anchor = link(t.href, parent);
        if (anchor) inline(t.text, anchor);
        else inline(t.text, parent);
      } else {
        var auto = link(t.href, parent);
        if (auto) auto.textContent = t.href;
        else text(t.href, parent);
      }
    }
    if (last < value.length) text(value.slice(last), parent);
  }

  var LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  var FENCE = new RegExp('^\\s*(' + TICK + '{3,}|~{3,})');
  var RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

  function isBlockStart(line, next) {
    return FENCE.test(line) || parseHeading(line) !== null || RULE.test(line) || /^\s*>/.test(line) || LIST.test(line) ||
      (line.indexOf('|') !== -1 && next !== undefined && DIVIDER.test(next));
  }
  function cells(line) {
    var trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map(function (c) { return c.trim(); });
  }
  function list(lines, i, indent) {
    var first = lines[i].match(LIST);
    var ordered = /\d/.test(first[2]);
    var node = el(ordered ? 'ol' : 'ul');
    if (ordered) node.start = parseInt(first[2], 10);
    while (i < lines.length) {
      var line = lines[i];
      var m = line.match(LIST);
      if (!line.trim()) {
        var ahead = i + 1;
        while (ahead < lines.length && !lines[ahead].trim()) ahead++;
        var nextItem = ahead < lines.length ? lines[ahead].match(LIST) : null;
        if (nextItem && nextItem[1].length >= indent) { i = ahead; continue; }
        break;
      }
      if (m && m[1].length > indent && node.lastChild) {
        var nested = list(lines, i, m[1].length);
        node.lastChild.appendChild(nested[0]);
        i = nested[1];
        continue;
      }
      if (!m && /^\s+\S/.test(line) && node.lastChild) {
        node.lastChild.appendChild(el('br'));
        inline(line.trim(), node.lastChild);
        i++;
        continue;
      }
      if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
      var item = el('li');
      var task = m[3].match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) {
        item.appendChild(document.createTextNode(task[1] === ' ' ? '☐ ' : '☑ '));
        inline(task[2], item);
      } else inline(m[3], item);
      node.appendChild(item);
      i++;
    }
    return [node, i];
  }
  function blocks(source, parent) {
    var lines = source.replace(/\r\n?/g, '\n').split('\n');
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }
      var fence = line.match(FENCE);
      if (fence) {
        var body = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0) { body.push(lines[i]); i++; }
        i++;
        parent.appendChild(el('pre')).appendChild(el('code', body.join('\n')));
        continue;
      }
      var heading = parseHeading(line);
      if (heading) { inline(heading.text, parent.appendChild(el('h' + heading.level))); i++; continue; }
      if (RULE.test(line)) { parent.appendChild(el('hr')); i++; continue; }
      if (/^\s*>/.test(line)) {
        var quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { quoted.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        blocks(quoted.join('\n'), parent.appendChild(el('blockquote')));
        continue;
      }
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && DIVIDER.test(lines[i + 1])) {
        var wrap = parent.appendChild(el('div'));
        wrap.className = 'table';
        var table = wrap.appendChild(el('table'));
        var headRow = table.appendChild(el('thead')).appendChild(el('tr'));
        cells(line).forEach(function (c) { inline(c, headRow.appendChild(el('th'))); });
        var tbody = table.appendChild(el('tbody'));
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
          var row = tbody.appendChild(el('tr'));
          cells(lines[i]).forEach(function (c) { inline(c, row.appendChild(el('td'))); });
          i++;
        }
        continue;
      }
      var item = line.match(LIST);
      if (item) {
        var built = list(lines, i, item[1].length);
        parent.appendChild(built[0]);
        i = built[1];
        continue;
      }
      var paragraph = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) { paragraph.push(lines[i]); i++; }
      inline(paragraph.join('\n'), parent.appendChild(el('p')));
    }
  }

  function b64(value) {
    var padded = value.replace(/-/g, '+').replace(/_/g, '/');
    padded += '===='.slice((padded.length % 4) || 4);
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document';
  }

  var key = new URLSearchParams(location.hash.slice(1)).get('k');
  if (!key) { fail('This link is incomplete. Ask for the link again and open it in full.'); return; }
  var dataUrl = location.pathname.replace(/\/$/, '') + '/data';
  fetch(dataUrl, { cache: 'no-store', credentials: 'omit' })
    .then(function (response) {
      if (response.status === 404 || response.status === 410) throw new Error('gone');
      if (!response.ok) throw new Error('unavailable');
      return response.arrayBuffer();
    })
    .then(function (buffer) {
      var sealed = new Uint8Array(buffer);
      return crypto.subtle.importKey('raw', b64(key), 'AES-GCM', false, ['decrypt']).then(function (cryptoKey) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, cryptoKey, sealed.slice(12));
      });
    })
    .then(function (plain) {
      var doc = JSON.parse(new TextDecoder().decode(plain));
      document.title = doc.title;
      status.hidden = true;
      article.hidden = false;
      var markdown = String(doc.content);
      if (!/^\s*#\s/.test(markdown)) article.appendChild(el('h1', doc.title));
      blocks(markdown, article);
      footer.textContent = 'Created ' + new Date(doc.createdAt).toLocaleString() + '. Anyone with this link can read it until it expires.';
      var copy = el('button', 'Copy text');
      copy.type = 'button';
      copy.addEventListener('click', function () {
        navigator.clipboard.writeText(markdown).then(function () { copy.textContent = 'Copied'; }, function () { copy.textContent = 'Copy failed'; });
      });
      var download = el('a', 'Download .md');
      download.className = 'download';
      download.href = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
      download.download = slug(doc.title) + '.md';
      actions.appendChild(copy);
      actions.appendChild(download);
    })
    .catch(function (error) {
      fail(error && error.message === 'gone'
        ? 'This document has expired or was removed.'
        : 'This document could not be opened. The link may be incomplete or damaged.');
    });
})();
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  let binary = '';
  for (const byte of new Uint8Array(digest))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

let policyPromise: Promise<string> | undefined;

/** Only this page's own script and style may run; it may only fetch its origin. */
export function viewerContentSecurityPolicy(): Promise<string> {
  policyPromise ??= Promise.all([
    sha256Base64(VIEWER_SCRIPT),
    sha256Base64(VIEWER_STYLE),
  ]).then(
    ([script, style]) =>
      `default-src 'none'; script-src 'sha256-${script}'; style-src 'sha256-${style}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  return policyPromise;
}

export function viewerHtml(oracleName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta property="og:title" content="Shared document">
<meta property="og:description" content="Open the link to read it.">
<title>Shared document</title>
<style>${VIEWER_STYLE}</style>
</head>
<body>
<main>
<header><span class="from">Shared by ${escapeHtml(oracleName)}</span><span class="actions" id="actions"></span></header>
<p class="note" id="status">Opening…</p>
<article id="doc" hidden></article>
<footer id="meta"></footer>
</main>
<script>${VIEWER_SCRIPT}</script>
</body>
</html>`;
}
