/**
 * The oracle side of this package must never be able to sign or broadcast:
 * its runtime dependency is `zod` alone, and the root entry point imports
 * nothing but `zod` and its own modules. The wallet SDK and the client SDK
 * are reachable only from `./react`, which runs in the user's Portal.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

/**
 * Every module specifier a file loads: `import … from` / `export … from`
 * (multi-line too), bare side-effect `import '…'`, dynamic `import('…')` and
 * `require('…')`, with either quote style. Relative specifiers are the
 * package's own modules.
 */
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^;]*?\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
];

function moduleSpecifiers(text: string): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[2]),
  )
    .filter((specifier): specifier is string => specifier !== undefined)
    .filter((specifier) => !specifier.startsWith('.'));
}

function importedModules(file: string): string[] {
  return moduleSpecifiers(readFileSync(file, 'utf8'));
}

function readManifest(): { dependencies?: Record<string, string> } {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('package.json is not an object');
  }
  return parsed;
}

describe('the module specifier scan', () => {
  it('finds static, side-effect, dynamic and require imports in both quote styles', () => {
    const text = [
      "import { z } from 'zod';",
      'import {',
      '  a,',
      '} from "@cosmjs/stargate";',
      "import '@cosmjs/proto-signing';",
      'export * from "@ixo/impactxclient-sdk";',
      "const late = await import('@cosmjs/amino');",
      'const old = require("bip39");',
      "import { local } from './local.js';",
    ].join('\n');
    expect(moduleSpecifiers(text).sort()).toEqual([
      '@cosmjs/amino',
      '@cosmjs/proto-signing',
      '@cosmjs/stargate',
      '@ixo/impactxclient-sdk',
      'bip39',
      'zod',
    ]);
  });
});

describe('no signing capability on the oracle side', () => {
  it('depends on zod only at runtime', () => {
    expect(Object.keys(readManifest().dependencies ?? {})).toEqual(['zod']);
  });

  it('imports only zod outside ./react', () => {
    const files = sourceFiles(join(root, 'src')).filter(
      (file) => !file.includes(`${join('src', 'react')}`),
    );
    expect(files.length).toBeGreaterThan(0);
    const foreign = files.flatMap((file) =>
      importedModules(file)
        .filter((specifier) => specifier !== 'zod')
        .map((specifier) => `${file}: ${specifier}`),
    );
    expect(foreign).toEqual([]);
  });

  it('keeps the wallet and client SDKs inside ./react', () => {
    const reactImports = sourceFiles(join(root, 'src', 'react')).flatMap(
      importedModules,
    );
    expect([...new Set(reactImports)].sort()).toEqual([
      '@ixo/impactxclient-sdk',
      '@ixo/oracles-client-sdk',
      'react',
      'zod',
    ]);
  });
});
