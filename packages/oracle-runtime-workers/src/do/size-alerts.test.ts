import { describe, expect, it } from 'vitest';
import {
  crossedGbThreshold,
  START_ALERT_GB,
  storageAlertText,
} from './size-alerts';

const GB = 1024 * 1024 * 1024;

describe('crossedGbThreshold', () => {
  it('stays silent below the start watermark', () => {
    expect(crossedGbThreshold(0, 0)).toBeNull();
    expect(crossedGbThreshold(0.99 * GB, 0)).toBeNull();
  });

  it('fires once per whole-GB watermark from the start upward', () => {
    expect(crossedGbThreshold(1.2 * GB, 0)).toBe(1);
    // Same watermark again → already alerted.
    expect(crossedGbThreshold(1.9 * GB, 1)).toBeNull();
    expect(crossedGbThreshold(2.01 * GB, 1)).toBe(2);
    expect(crossedGbThreshold(7.5 * GB, 6)).toBe(7);
    expect(crossedGbThreshold(7.5 * GB, 7)).toBeNull();
    expect(crossedGbThreshold(9.4 * GB, 8)).toBe(9);
  });

  it('collapses a multi-GB jump into one alert at the current floor', () => {
    // e.g. a 7.3 GB legacy import on a user never alerted before.
    expect(crossedGbThreshold(7.3 * GB, 0)).toBe(7);
  });

  it('starts at the configured watermark', () => {
    expect(START_ALERT_GB).toBe(1);
    expect(crossedGbThreshold(3.5 * GB, 0, 3)).toBe(3);
  });
});

describe('storageAlertText', () => {
  it('names the user, the oracle, and the crossed watermark', () => {
    const text = storageAlertText({
      oracleName: 'Mike Matrix Test',
      oracleDid: 'did:ixo:oracle',
      userDid: 'did:ixo:user123',
      fileBytes: 5.25 * GB,
      gb: 5,
    });
    expect(text).toContain('did:ixo:user123');
    expect(text).toContain('did:ixo:oracle');
    expect(text).toContain('crossed 5 GB');
    expect(text).toContain('5.25 GB');
    expect(text).toContain('10 GB');
  });
});
