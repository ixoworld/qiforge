import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyLlmError } from '../../llm/provider-error.js';
import {
  resolveErrorSimulation,
  type SimulationDirective,
} from './error-simulation.js';

function asThrow(
  directive: SimulationDirective | null,
): Extract<SimulationDirective, { action: 'throw' }> {
  if (directive?.action !== 'throw') {
    throw new Error(`expected a throw directive, got ${directive?.action}`);
  }
  return directive;
}

function asNotice(
  directive: SimulationDirective | null,
): Extract<SimulationDirective, { action: 'notice' }> {
  if (directive?.action !== 'notice') {
    throw new Error(`expected a notice directive, got ${directive?.action}`);
  }
  return directive;
}

describe('resolveErrorSimulation', () => {
  const originalFlag = process.env.ALLOW_ERROR_SIMULATION;

  beforeEach(() => {
    process.env.ALLOW_ERROR_SIMULATION = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.ALLOW_ERROR_SIMULATION;
    } else {
      process.env.ALLOW_ERROR_SIMULATION = originalFlag;
    }
  });

  it('is inert when the env gate is off', () => {
    delete process.env.ALLOW_ERROR_SIMULATION;
    expect(resolveErrorSimulation('/simulate-error deepseek:billing')).toBe(
      null,
    );
  });

  it('is inert for ordinary messages', () => {
    expect(resolveErrorSimulation('hello there')).toBe(null);
    expect(resolveErrorSimulation(undefined)).toBe(null);
  });

  it('every throw preset classifies to the kind its name promises', () => {
    const expectations: Record<string, string> = {
      'openai:billing': 'billing',
      'openai:rate_limit': 'rate_limit',
      'openai:auth': 'auth',
      'anthropic:billing': 'billing',
      'anthropic:rate_limit': 'rate_limit',
      'anthropic:auth': 'auth',
      'deepseek:billing': 'billing',
      'gemini:rate_limit': 'rate_limit',
      'chatgpt:usage_limit': 'rate_limit',
      'chatgpt:auth': 'auth',
      server: 'server',
      timeout: 'timeout',
      network: 'network',
      unknown: 'unknown',
    };
    const observed = Object.keys(expectations).map((preset) => {
      const directive = asThrow(
        resolveErrorSimulation(`/simulate-error ${preset}`),
      );
      const classified = classifyLlmError(directive.error, {
        byoProvider: directive.byoProvider,
      });
      return {
        preset,
        kind: classified.kind,
        provider: classified.provider ?? null,
      };
    });
    expect(observed).toEqual(
      Object.entries(expectations).map(([preset, kind]) => ({
        preset,
        kind,
        provider: preset.includes(':') ? preset.split(':')[0] : null,
      })),
    );
  });

  it('fallback presets emit a notice instead of throwing', () => {
    const reconnect = asNotice(
      resolveErrorSimulation('/simulate-error fallback'),
    );
    expect(reconnect.payload.kind).toBe('byo_fallback');
    expect(reconnect.payload.reason).toBe('reconnect_required');

    const notConnected = asNotice(
      resolveErrorSimulation('/simulate-error fallback:not_connected'),
    );
    expect(notConnected.payload.reason).toBe('not_connected');
  });

  it('unknown presets throw a descriptive error listing what exists', () => {
    const directive = asThrow(
      resolveErrorSimulation('/simulate-error nonsense'),
    );
    expect(directive.error.message).toMatch(/Unknown simulation preset/);
    expect(directive.error.message).toMatch(/deepseek:billing/);
  });
});
