import { Logger } from '@nestjs/common';
import { emojify as nodeEmojify, unemojify as nodeUnemojify } from 'node-emoji';

const logger = new Logger('Emoji');

function toStringSafe(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

export function emojify(input: unknown): string {
  try {
    return nodeEmojify(input as string);
  } catch (err) {
    const str = toStringSafe(input);
    logger.debug(
      `emojify failed (${err instanceof Error ? err.message : String(err)}); returning input as-is. input=${str}`,
      input,
      err,
    );
    return str;
  }
}

export function unemojify(input: unknown): string {
  try {
    return nodeUnemojify(input as string);
  } catch (err) {
    const str = toStringSafe(input);
    logger.debug(
      `unemojify failed (${err instanceof Error ? err.message : String(err)}); returning input as-is. input=${str}`,
      input,
      err
    );
    return str;
  }
}
