import { describe, expect, it } from 'vitest';
import {
  shouldVacuum,
  vacuumWanted,
  VACUUM_IDLE_MS,
  VACUUM_MIN_INTERVAL_MS,
  type VacuumPolicyInput,
} from './vacuum-policy';

const NOW = 1_700_000_000_000;

function input(overrides: Partial<VacuumPolicyInput> = {}): VacuumPolicyInput {
  return {
    now: NOW,
    lastAccessAt: NOW - VACUUM_IDLE_MS - 1,
    lastVacuumAt: undefined,
    dirty: false,
    exporting: false,
    fileBytes: 30 * 1024 * 1024,
    pageCount: 7680,
    freelistCount: 3000,
    ...overrides,
  };
}

describe('shouldVacuum', () => {
  it('rebuilds a quiet, clean, fragmented file', () => {
    const verdict = shouldVacuum(input());
    expect(verdict.vacuum).toBe(true);
    expect(verdict.freeShare).toBeCloseTo(3000 / 7680);
  });

  it('never runs while a turn is recent, a flush is reading, or the copy is dirty', () => {
    expect(shouldVacuum(input({ lastAccessAt: NOW - 1000 }))).toMatchObject({
      vacuum: false,
      reason: expect.stringContaining('active'),
    });
    expect(shouldVacuum(input({ exporting: true }))).toMatchObject({
      vacuum: false,
      reason: expect.stringContaining('flush'),
    });
    expect(shouldVacuum(input({ dirty: true }))).toMatchObject({
      vacuum: false,
      reason: expect.stringContaining('dirty'),
    });
  });

  it('skips small files, low free shares, recent rebuilds and files near the storage cap', () => {
    expect(shouldVacuum(input({ fileBytes: 1024 * 1024 })).vacuum).toBe(false);
    expect(
      shouldVacuum(input({ freelistCount: 100, pageCount: 7680 })).vacuum,
    ).toBe(false);
    expect(
      shouldVacuum(input({ lastVacuumAt: NOW - VACUUM_MIN_INTERVAL_MS / 2 }))
        .vacuum,
    ).toBe(false);
    expect(
      shouldVacuum(input({ lastVacuumAt: NOW - VACUUM_MIN_INTERVAL_MS - 1 }))
        .vacuum,
    ).toBe(true);
    expect(
      shouldVacuum(input({ fileBytes: 5 * 1024 * 1024 * 1024 })).vacuum,
    ).toBe(false);
  });
});

describe('vacuumWanted', () => {
  it('reports the size/fragmentation gates only, so the object can re-check once quiet', () => {
    expect(vacuumWanted(input({ lastAccessAt: NOW, dirty: true }))).toBe(true);
    expect(vacuumWanted(input({ freelistCount: 0 }))).toBe(false);
  });
});
