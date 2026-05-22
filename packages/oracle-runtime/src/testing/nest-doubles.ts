import type { ConfigService } from '@nestjs/config';
import { vi } from 'vitest';

/**
 * Typed `ConfigService` double for NestJS module tests. `get` returns the
 * value or undefined; `getOrThrow` throws when the key is absent. The
 * `as unknown as ConfigService` lives at the boundary because the real
 * service exposes additional internal methods (`changes`, `internalConfig`,
 * etc.) that no SUT in this repo consumes.
 */
export function makeConfig(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: vi.fn(<T>(key: string): T | undefined => values[key] as T | undefined),
    getOrThrow: vi.fn(<T>(key: string): T => {
      if (!(key in values)) {
        throw new Error(`Config "${key}" missing`);
      }
      return values[key] as T;
    }),
  } as unknown as ConfigService;
}
