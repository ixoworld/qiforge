/**
 * Drop-in replacement for the `jsdom` package on workerd, backed by linkedom.
 *
 * `@blocknote/server-util` does `import * as jsdom from 'jsdom'` and
 * `new jsdom.JSDOM()` purely to get a `window`/`document` pair it can swap
 * onto `globalThis` while BlockNote's markdown/HTML parsing runs. Real jsdom
 * cannot load on workerd (it needs `node:vm` script contexts, which
 * nodejs_compat only stubs), so the module specifier `jsdom` is aliased to
 * this file — in `vitest.config.ts` (`resolve.alias`) and
 * `test/wrangler.test.jsonc` (`alias`) for tests, and deploying hosts must
 * carry the same `alias` entry in their wrangler config.
 *
 * linkedom implements the exact DOM surface the BlockNote parse path touches
 * (`createElement`, `innerHTML`, `querySelectorAll` with `>`/`+` combinators,
 * `insertAdjacentElement`, prosemirror-model's `DOMParser.parse` walk) with
 * one gap: `document.implementation.createHTMLDocument`, which BlockNote's
 * `nestedListsToBlockNoteStructure` uses to build a detached document. The
 * constructor polyfills it with a fresh linkedom document.
 */
import { parseHTML } from 'linkedom';

const EMPTY_PAGE =
  '<!doctype html><html><head><title>jsdom-shim</title></head><body></body></html>';

interface DomImplementationLike {
  createHTMLDocument(title?: string): unknown;
}

/**
 * The `jsdom.JSDOM` surface `@blocknote/server-util` consumes: a constructible
 * class exposing `window` (with `document` on it). Nothing else from jsdom's
 * API is provided — BlockNote's server path never touches it.
 */
export class JSDOM {
  readonly window: ReturnType<typeof parseHTML>;

  constructor(html: string = EMPTY_PAGE) {
    const { window } = parseHTML(html);
    const doc = window.document;
    if (!doc.implementation) {
      const implementation: DomImplementationLike = {
        createHTMLDocument(title = '') {
          return parseHTML(
            `<!doctype html><html><head><title>${title}</title></head><body></body></html>`,
          ).document;
        },
      };
      Object.defineProperty(doc, 'implementation', {
        value: implementation,
        configurable: true,
      });
    }
    this.window = window;
  }
}
