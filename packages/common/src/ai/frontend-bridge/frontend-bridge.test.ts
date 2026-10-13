import { describe, expect, it } from 'vitest';
import {
  FRONTEND_BRIDGE,
  FRONTEND_OUTCOME_UNKNOWN,
  frontendInvocationId,
  frontendOutcomeUnknown,
  reportsUnknownOutcome,
  summarizeFrontendResult,
} from './index.js';

const COMMAND_ID = 'a'.repeat(64);

describe('frontend bridge contract', () => {
  it('advertises the version the Portal gates conversational writes on', () => {
    // The Portal enables writes only on exactly these three values.
    expect(FRONTEND_BRIDGE).toEqual({
      protocolVersion: 2,
      execution: 'single-socket',
      timeoutOutcome: 'unknown',
    });
  });

  it('gives every invocation a distinct id that keeps the caller id readable', () => {
    const a = frontendInvocationId('tc-turn');
    const b = frontendInvocationId('tc-turn');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^tc-turn:[0-9a-f-]{36}$/);
  });

  it('builds the unknown outcome the Portal recovers from', () => {
    const unknown = frontendOutcomeUnknown('tc-turn:1');
    expect(unknown).toMatchObject({
      success: false,
      code: FRONTEND_OUTCOME_UNKNOWN,
      outcome: 'unknown',
      invocationId: 'tc-turn:1',
    });
    expect(unknown.message).toContain('original command ID');
    expect(reportsUnknownOutcome(unknown)).toBe(true);
    expect(reportsUnknownOutcome({ success: false, outcome: 'unknown' })).toBe(
      true,
    );
    expect(reportsUnknownOutcome({ success: false, error: 'denied' })).toBe(
      false,
    );
    expect(reportsUnknownOutcome('unknown')).toBe(false);
  });

  it('summarizes a result for diagnostics without its content', () => {
    expect(
      summarizeFrontendResult(
        { commandId: COMMAND_ID, status: 'completed', body: 'secret text' },
        'inv-1',
      ),
    ).toEqual({
      result: { invocationId: 'inv-1', commandId: COMMAND_ID },
      success: true,
    });
    // A command id that is not a SHA-256 digest is user content, not an id.
    expect(
      summarizeFrontendResult({ commandId: 'free text' }, undefined),
    ).toEqual({ result: {}, success: true });
    expect(
      summarizeFrontendResult(frontendOutcomeUnknown('inv-2'), 'inv-2'),
    ).toEqual({
      result: { invocationId: 'inv-2', outcome: 'unknown' },
      success: false,
    });
    expect(
      summarizeFrontendResult({ success: false, error: 'denied' }, 'inv-3'),
    ).toEqual({ result: { invocationId: 'inv-3' }, success: false });
    expect(summarizeFrontendResult('plain text', 'inv-4')).toEqual({
      result: { invocationId: 'inv-4' },
      success: true,
    });
  });
});
