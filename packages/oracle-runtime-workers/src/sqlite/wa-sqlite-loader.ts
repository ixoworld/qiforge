/**
 * Instantiates wa-sqlite (SQLite compiled to WebAssembly) on workerd.
 *
 * Why this file exists:
 * - workerd disallows runtime wasm compilation (`WebAssembly.compile`,
 *   `new WebAssembly.Module(bytes)`, `instantiateStreaming`). The Emscripten
 *   factory in `wa-sqlite/dist/wa-sqlite.mjs` would normally fetch + compile
 *   `wa-sqlite.wasm`; instead we import the `.wasm` as a build-time
 *   `CompiledWasm` module (a ready `WebAssembly.Module`) and hand it to the
 *   factory through its `instantiateWasm(imports, receiveInstance)` hook,
 *   which only needs the synchronous `new WebAssembly.Instance(module, imports)`.
 * - We use the SYNC build (`wa-sqlite.mjs`, not the Asyncify `-async` build):
 *   Durable Object storage (`ctx.storage.sql.exec`) is synchronous, so the VFS
 *   can be fully synchronous — faster and far simpler than Asyncify.
 *
 * Contract verified against `wa-sqlite@1.0.0`:
 * - `dist/wa-sqlite.mjs` default export: `(moduleArg?) => Promise<Module>`.
 *   If `moduleArg.instantiateWasm` is set it is called as
 *   `instantiateWasm(imports, receiveInstance)` and must return the exports.
 *   Without `moduleArg.locateFile` the factory evaluates
 *   `new URL('wa-sqlite.wasm', import.meta.url)` eagerly — we set `locateFile`
 *   to skip that (it's never fetched anyway).
 * - `src/sqlite-api.js` `Factory(module)` builds the JS API; `vfs_register`
 *   delegates to `module.registerVFS(vfs, makeDefault)` which throws when a VFS
 *   name is already registered (there is no unregister), hence the registry
 *   below.
 *
 * One Emscripten module instance is cached per isolate. Many Durable Objects in
 * the same isolate share it; each DO registers its own VFS (named after the DO
 * id) so different objects open different databases on the same instance.
 */
import './wasm.d';
import * as SQLite from 'wa-sqlite';
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import wasmModule from 'wa-sqlite/dist/wa-sqlite.wasm';

/** The subset of the Emscripten module surface this runtime relies on. */
export interface WaSqliteModule {
  /** Current wasm heap view (re-created by Emscripten when memory grows). */
  HEAPU8: Uint8Array;
  registerVFS(vfs: SQLiteVFS, makeDefault?: boolean): number;
}

export interface SqliteRuntime {
  sqlite3: SQLiteAPI;
  module: WaSqliteModule;
}

interface ModuleFactoryArgs {
  locateFile(path: string, scriptDirectory: string): string;
  instantiateWasm(
    imports: WebAssembly.Imports,
    receiveInstance: (instance: WebAssembly.Instance) => void,
  ): WebAssembly.Exports;
}

let runtimePromise: Promise<SqliteRuntime> | undefined;

/**
 * Returns the per-isolate SQLite runtime, instantiating it on first use.
 * Safe to call concurrently; all callers share one promise.
 */
export function loadSqlite(): Promise<SqliteRuntime> {
  runtimePromise ??= instantiate().catch((error: unknown) => {
    // Let a later call retry instead of caching a rejected promise forever.
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

async function instantiate(): Promise<SqliteRuntime> {
  const args: ModuleFactoryArgs = {
    locateFile: (path) => path,
    instantiateWasm: (imports, receiveInstance) => {
      const instance = new WebAssembly.Instance(wasmModule, imports);
      receiveInstance(instance);
      return instance.exports;
    },
  };
  const module: WaSqliteModule = await SQLiteESMFactory(args);
  const sqlite3 = SQLite.Factory(module);
  return { sqlite3, module };
}

/**
 * VFS objects registered on the shared module, keyed by VFS name. SQLite has
 * no "unregister" in the wa-sqlite glue, so a Durable Object that is evicted
 * and re-created in the same isolate re-uses (and re-binds) its VFS object
 * rather than registering a second one under the same name.
 */
const vfsRegistry = new Map<string, SQLiteVFS>();

/**
 * Register `create()`'s VFS under `name` unless one is already registered, in
 * which case the existing object is returned and `create` is not called.
 */
export function getOrRegisterVfs<V extends SQLiteVFS>(
  runtime: SqliteRuntime,
  name: string,
  create: () => V,
  isInstance: (vfs: SQLiteVFS) => vfs is V,
): V {
  const existing = vfsRegistry.get(name);
  if (existing !== undefined) {
    if (!isInstance(existing)) {
      throw new Error(
        `VFS '${name}' is registered with a different implementation`,
      );
    }
    return existing;
  }
  const vfs = create();
  runtime.sqlite3.vfs_register(vfs, false);
  vfsRegistry.set(name, vfs);
  return vfs;
}

/** SQLite library version string of the loaded build (e.g. `3.45.1`). */
export async function sqliteVersion(): Promise<string> {
  const { sqlite3 } = await loadSqlite();
  return sqlite3.libversion();
}
