import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveLangsmithTracing,
  type ResolveLangsmithTracingArgs,
} from './langsmith-tracing.js';

const USER_DID = 'did:ixo:ixo1traceduser';
const OTHER_DID = 'did:ixo:ixo1otheruser';

function makeArgs(
  overrides: Partial<ResolveLangsmithTracingArgs> = {},
): ResolveLangsmithTracingArgs {
  return {
    userDid: USER_DID,
    client: 'portal',
    env: {},
    ...overrides,
  };
}

describe('resolveLangsmithTracing', () => {
  it('always returns user + client metadata, even with no LangSmith config', () => {
    const decision = resolveLangsmithTracing(makeArgs());
    expect(decision.metadata.user_did).toBe(USER_DID);
    expect(decision.metadata.user_id).toBe(USER_DID);
    expect(decision.metadata.client).toBe('portal');
    expect(decision.callbacks).toBeUndefined();
  });

  it('includes pre-graph timings in metadata when provided', () => {
    const decision = resolveLangsmithTracing(
      makeArgs({
        timings: { prepareDurationMs: 42, agentBuildDurationMs: 137 },
      }),
    );
    expect(decision.metadata.prepare_duration_ms).toBe(42);
    expect(decision.metadata.agent_build_duration_ms).toBe(137);
  });

  it('omits timing keys entirely when timings are absent', () => {
    const decision = resolveLangsmithTracing(makeArgs());
    expect(decision.metadata).not.toHaveProperty('prepare_duration_ms');
    expect(decision.metadata).not.toHaveProperty('agent_build_duration_ms');
  });

  it('attaches a tracer when the DID is allowlisted and an API key is set', () => {
    const decision = resolveLangsmithTracing(
      makeArgs({
        env: {
          apiKey: 'ls-key',
          project: 'account-oracle-devnet',
          tracedDids: `${OTHER_DID},${USER_DID}`,
        },
      }),
    );
    expect(decision.callbacks).toHaveLength(1);
    const tracer = decision.callbacks?.[0];
    expect(tracer).toBeInstanceOf(LangChainTracer);
    expect(tracer?.projectName).toBe('account-oracle-devnet');
  });

  it('falls back to LangChain resolution of the project name when the project env is unset', () => {
    // The tracer resolves the project itself (process env, then 'default') —
    // this module must not override that with an explicit undefined.
    vi.stubEnv('LANGSMITH_PROJECT', 'env-resolved-project');
    try {
      const decision = resolveLangsmithTracing(
        makeArgs({ env: { apiKey: 'ls-key', tracedDids: USER_DID } }),
      );
      expect(decision.callbacks?.[0]?.projectName).toBe('env-resolved-project');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not attach a tracer when the DID is not in the allowlist', () => {
    const decision = resolveLangsmithTracing(
      makeArgs({ env: { apiKey: 'ls-key', tracedDids: OTHER_DID } }),
    );
    expect(decision.callbacks).toBeUndefined();
  });

  it('matches DIDs exactly — a prefix of an allowlisted DID is not traced', () => {
    const decision = resolveLangsmithTracing(
      makeArgs({
        userDid: 'did:ixo:ixo1trace',
        env: { apiKey: 'ls-key', tracedDids: USER_DID },
      }),
    );
    expect(decision.callbacks).toBeUndefined();
  });

  it('traces every user when the allowlist is the * wildcard', () => {
    for (const userDid of [USER_DID, OTHER_DID]) {
      const decision = resolveLangsmithTracing(
        makeArgs({ userDid, env: { apiKey: 'ls-key', tracedDids: '*' } }),
      );
      expect(decision.callbacks).toHaveLength(1);
    }
  });

  it('tolerates whitespace and empty entries in the allowlist', () => {
    const decision = resolveLangsmithTracing(
      makeArgs({
        env: {
          apiKey: 'ls-key',
          tracedDids: ` ${OTHER_DID} , , ${USER_DID} ,`,
        },
      }),
    );
    expect(decision.callbacks).toHaveLength(1);
  });

  it('fails closed: no tracer without an API key even when the DID is allowlisted', () => {
    const decision = resolveLangsmithTracing(
      makeArgs({ env: { tracedDids: USER_DID } }),
    );
    expect(decision.callbacks).toBeUndefined();
  });

  it('does not attach an explicit tracer in global mode (LangChain auto-attaches its own)', () => {
    const decision = resolveLangsmithTracing(
      makeArgs({
        env: { tracing: 'true', apiKey: 'ls-key', tracedDids: USER_DID },
      }),
    );
    expect(decision.callbacks).toBeUndefined();
    expect(decision.metadata.user_did).toBe(USER_DID);
  });

  it('treats only the exact string "true" as global mode, mirroring LangChain', () => {
    const decision = resolveLangsmithTracing(
      makeArgs({
        env: { tracing: 'false', apiKey: 'ls-key', tracedDids: USER_DID },
      }),
    );
    expect(decision.callbacks).toHaveLength(1);
  });

  it('re-parses the allowlist when the raw env value changes between calls', () => {
    const before = resolveLangsmithTracing(
      makeArgs({ env: { apiKey: 'ls-key', tracedDids: OTHER_DID } }),
    );
    expect(before.callbacks).toBeUndefined();

    const after = resolveLangsmithTracing(
      makeArgs({
        env: { apiKey: 'ls-key', tracedDids: `${OTHER_DID},${USER_DID}` },
      }),
    );
    expect(after.callbacks).toHaveLength(1);
  });
});
