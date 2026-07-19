import { emojify as nodeEmojify, unemojify as nodeUnemojify } from 'node-emoji';

/**
 * Optional debug sink for the fallback paths below. Dependency-free so this
 * module stays importable from web-standard runtimes; the Node host may wire
 * its structured logger in at boot. Silent by default — these are
 * diagnostics, not user-facing errors.
 */
type EmojiDebugLogger = (message: string, ...rest: unknown[]) => void;
let debugLog: EmojiDebugLogger | undefined;

export function setEmojiDebugLogger(
  logger: EmojiDebugLogger | undefined,
): void {
  debugLog = logger;
}

function toStringSafe(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

export function emojify(input: unknown): string {
  if (typeof input !== 'string') {
    debugLog?.(
      'emojify received non-string input; returning input as-is.',
      input,
    );
  }
  try {
    return nodeEmojify(String(input));
  } catch (err) {
    const str = toStringSafe(input);
    debugLog?.(
      `emojify failed (${err instanceof Error ? err.message : String(err)}); returning input as-is. input=${str}`,
      input,
      err,
    );

    return str;
  }
}

export function unemojify(input: unknown): string {
  try {
    if (typeof input !== 'string') {
      throw new TypeError('unemojify expects a string');
    }
    return nodeUnemojify(input);
  } catch (err) {
    const str = toStringSafe(input);
    debugLog?.(
      `unemojify failed (${err instanceof Error ? err.message : String(err)}); returning input as-is. input=${str}`,
      input,
      err,
    );
    return str;
  }
}
