import { beforeEach, describe, expect, it } from 'vitest';
import { tenantScopeKey, type CodexTenantScope } from '../domain/provider.js';
import {
  CodexConnectionState,
  CodexTransitionError,
  canTransition,
} from './connection-state.js';

const scope: CodexTenantScope = {
  userDid: 'did:ixo:user1',
  oracleEntityDid: 'did:ixo:oracle1',
};

describe('CodexConnectionState', () => {
  let clock: number;
  let state: CodexConnectionState;

  beforeEach(() => {
    clock = 1_000;
    state = new CodexConnectionState(scope, 'api_key', () => clock);
  });

  it('starts disconnected', () => {
    expect(state.current()).toBe('disconnected');
    expect(state.snapshot().authMode).toBe('api_key');
  });

  it('records the happy-path connect sequence in the audit trail', () => {
    state.transition('connecting', 'connect_requested');
    clock = 2_000;
    state.transition('connected', 'handshake_ok');

    const history = state.history();
    expect(history.map((entry) => entry.to)).toEqual([
      'connecting',
      'connected',
    ]);
    expect(history[1]?.from).toBe('connecting');
    expect(history[1]?.at).toBe(2_000);
    expect(history[1]?.reason).toBe('handshake_ok');
  });

  it('scopes every transition to the tenant key', () => {
    state.transition('connecting', 'connect_requested');
    expect(state.history()[0]?.tenant).toBe(tenantScopeKey(scope));
  });

  it('rejects an illegal edge instead of silently corrupting state', () => {
    expect(() => state.transition('connected', 'handshake_ok')).toThrow(
      CodexTransitionError,
    );
    expect(state.current()).toBe('disconnected');
  });

  it('allows a same-state transition so repeated signals are idempotent', () => {
    expect(() =>
      state.transition('disconnected', 'disconnect_requested'),
    ).not.toThrow();
  });

  it('surfaces an authorization url only while awaiting device authorization', () => {
    state.transition('connecting', 'connect_requested');
    state.transition('requires_device_authorization', 'auth_pending_browser', {
      authorizationUrl: 'https://auth.example/device',
    });
    expect(state.snapshot().authorizationUrl).toBe(
      'https://auth.example/device',
    );

    state.transition('connecting', 'connect_requested');
    expect(state.snapshot().authorizationUrl).toBeUndefined();
  });

  it('caps the audit trail', () => {
    const bounded = new CodexConnectionState(scope, 'api_key', () => clock, 3);
    for (let i = 0; i < 6; i += 1) {
      bounded.transition('connecting', 'connect_requested');
      bounded.transition('disconnected', 'disconnect_requested');
    }
    expect(bounded.history()).toHaveLength(3);
  });

  describe('setAuthMode', () => {
    it('emits a transition so the switch is observable', () => {
      const record = state.setAuthMode('chatgpt_subscription');

      expect(record.reason).toBe('auth_mode_changed');
      expect(state.snapshot().authMode).toBe('chatgpt_subscription');
    });

    it('drops an established connection so credentials cannot carry over', () => {
      state.transition('connecting', 'connect_requested');
      state.transition('connected', 'handshake_ok');

      state.setAuthMode('chatgpt_subscription');

      expect(state.current()).toBe('disconnected');
      expect(state.history().some((entry) => entry.from === 'connected')).toBe(
        true,
      );
    });

    it('refuses a no-op switch rather than logging a meaningless change', () => {
      expect(() => state.setAuthMode('api_key')).toThrow(/already/u);
    });
  });
});

describe('canTransition', () => {
  it('permits recovery from a failed auth', () => {
    expect(canTransition('invalid_credentials', 'connecting')).toBe(true);
  });

  it('forbids jumping straight from disconnected to connected', () => {
    expect(canTransition('disconnected', 'connected')).toBe(false);
  });
});
