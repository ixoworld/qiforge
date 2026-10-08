/**
 * The `@ixo/domain.md` validators the resolver calls, behind one object so a
 * test can observe (spy on) how often parsing actually happens.
 *
 * The library (compiled JSON-schema validators, about 1.2 MB) is bundled with
 * the Worker but evaluated on first use only: it is loaded with a dynamic
 * `import()`, so an oracle that never turns domain context on does not pay
 * for it at isolate start.
 */
import type * as DomainMd from '@ixo/domain.md/workers';

type Library = typeof DomainMd;

let library: Promise<Library> | undefined;

function load(): Promise<Library> {
  library ??= import('@ixo/domain.md/workers').catch((error: unknown) => {
    // A failed load is retried by the next caller instead of cached.
    library = undefined;
    throw error;
  });
  return library;
}

export const domainValidator = {
  async parseDomain(
    ...args: Parameters<Library['parseDomain']>
  ): Promise<ReturnType<Library['parseDomain']>> {
    return (await load()).parseDomain(...args);
  },
  async lint(
    ...args: Parameters<Library['lint']>
  ): Promise<ReturnType<Library['lint']>> {
    return (await load()).lint(...args);
  },
  async validateOracleCapsule(
    ...args: Parameters<Library['validateOracleCapsule']>
  ): Promise<ReturnType<Library['validateOracleCapsule']>> {
    return (await load()).validateOracleCapsule(...args);
  },
};
