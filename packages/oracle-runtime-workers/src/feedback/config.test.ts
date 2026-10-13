import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID } from '../core/llm';
import {
  DEFAULT_FEEDBACK_LINEAR_API_URL,
  DEFAULT_FEEDBACK_LINEAR_PROJECT_ID,
  DEFAULT_FEEDBACK_LINEAR_TEAM_ID,
  feedbackConfigFromEnv,
} from './config';

const base = { ORACLE_NAME: 'Agent', ORACLE_DID: 'did:ixo:oracle' };
const KEY = 'lin_api_restricted_key';
const SECRET = 's'.repeat(32);

describe('feedbackConfigFromEnv', () => {
  it('is off when neither the Linear key nor the HMAC secret is set', () => {
    expect(feedbackConfigFromEnv(base)).toBeNull();
    expect(
      feedbackConfigFromEnv({
        ...base,
        FEEDBACK_LINEAR_API_KEY: ' ',
        FEEDBACK_HMAC_SECRET: '',
      }),
    ).toBeNull();
  });

  it('fails the boot when only one of the two is set, naming the missing key and never a value', () => {
    expect(() =>
      feedbackConfigFromEnv({ ...base, FEEDBACK_LINEAR_API_KEY: KEY }),
    ).toThrow(/half-configured.*missing: FEEDBACK_HMAC_SECRET/);
    expect(() =>
      feedbackConfigFromEnv({ ...base, FEEDBACK_HMAC_SECRET: SECRET }),
    ).toThrow(/missing: FEEDBACK_LINEAR_API_KEY/);
  });

  it('fails the boot on a short secret or a malformed destination, without echoing values', () => {
    let message = '';
    try {
      feedbackConfigFromEnv({
        ...base,
        FEEDBACK_LINEAR_API_KEY: KEY,
        FEEDBACK_HMAC_SECRET: 'short-secret-value',
        FEEDBACK_LINEAR_PROJECT_ID: 'not-a-uuid',
        FEEDBACK_LINEAR_API_URL: 'http://linear.example.com/graphql',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/FEEDBACK_HMAC_SECRET/);
    expect(message).toMatch(/FEEDBACK_LINEAR_PROJECT_ID/);
    expect(message).toMatch(/FEEDBACK_LINEAR_API_URL/);
    expect(message).not.toContain('short-secret-value');
    expect(message).not.toContain(KEY);
  });

  it('defaults to the Studio team and the User Feedback from Portal project', () => {
    const config = feedbackConfigFromEnv({
      ...base,
      FEEDBACK_LINEAR_API_KEY: KEY,
      FEEDBACK_HMAC_SECRET: SECRET,
    });
    expect(config).toEqual({
      hmacSecret: SECRET,
      linear: {
        apiUrl: DEFAULT_FEEDBACK_LINEAR_API_URL,
        apiKey: KEY,
        teamId: DEFAULT_FEEDBACK_LINEAR_TEAM_ID,
        projectId: DEFAULT_FEEDBACK_LINEAR_PROJECT_ID,
        labelIds: [],
      },
      agent: {
        did: 'did:ixo:oracle',
        name: 'Agent',
        model: DEFAULT_MODEL_ID,
        provider: 'openrouter',
        runtimeBuildVersion: 'unknown',
      },
    });
    expect(DEFAULT_FEEDBACK_LINEAR_TEAM_ID).toBe(
      'c781a53a-d432-469f-9c9c-2345a0f8243b',
    );
    expect(DEFAULT_FEEDBACK_LINEAR_PROJECT_ID).toBe(
      '6c1474a9-620c-4e3c-b443-0263992f3b55',
    );
  });

  it('reads overrides, labels and the coarse Agent context', () => {
    const label = '11111111-2222-4333-8444-555555555555';
    const config = feedbackConfigFromEnv({
      ...base,
      ORACLE_ENTITY_DID: 'did:ixo:entity',
      DEFAULT_MODEL: 'anthropic/claude',
      LLM_PROVIDER: 'nebius',
      QIFORGE_BUILD_VERSION: 'abc123',
      FEEDBACK_LINEAR_API_KEY: KEY,
      FEEDBACK_HMAC_SECRET: SECRET,
      FEEDBACK_LINEAR_LABEL_IDS: ` ${label} ,`,
      FEEDBACK_LINEAR_API_URL: 'http://127.0.0.1:9999/graphql',
    });
    expect(config?.linear.labelIds).toEqual([label]);
    expect(config?.linear.apiUrl).toBe('http://127.0.0.1:9999/graphql');
    expect(config?.agent).toEqual({
      did: 'did:ixo:entity',
      name: 'Agent',
      model: 'anthropic/claude',
      provider: 'nebius',
      runtimeBuildVersion: 'abc123',
    });
  });
});
