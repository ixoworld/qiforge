import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { ZodError } from 'zod';

import { renderIframeEvent } from './iframe.js';
import { renderSigningPayload } from './render.js';
import { validateTransactionDraft } from './validate.js';

export type CliMode = 'validate' | 'render' | 'iframe';

function readJsonArgument(): unknown {
  const inline = process.argv.slice(2).join(' ').trim();
  const raw = inline.length > 0 ? inline : readFileSync(0, 'utf8').trim();
  if (!raw)
    throw new Error(
      'Provide a JSON transaction draft argument or pipe JSON on stdin',
    );
  return JSON.parse(raw);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function runCli(mode: CliMode): void {
  try {
    const input = readJsonArgument();
    if (mode === 'validate') {
      printJson(validateTransactionDraft(input));
      return;
    }
    if (mode === 'render') {
      printJson(renderSigningPayload(input));
      return;
    }
    printJson(renderIframeEvent(input));
  } catch (error) {
    const message =
      error instanceof ZodError
        ? JSON.stringify(error.flatten(), null, 2)
        : error instanceof Error
          ? error.message
          : inspect(error, { depth: 8 });
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
