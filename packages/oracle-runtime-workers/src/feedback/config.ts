/**
 * Anonymous feedback configuration, read from the Worker env by the shell.
 *
 * The keys are deliberately NOT part of the validated base env
 * (`src/core/env.ts`), so they never appear in the `ctx.config` plugins
 * receive, and `composeEnvSchema` refuses a plugin whose `configSchema`
 * declares a `FEEDBACK_` key. That is the whole guarantee: a plugin HTTP
 * route (`PluginRoute.handler`) is handed the raw Worker env, which holds
 * these keys like every other binding and secret.
 *
 * Off unless both the Linear key and the HMAC secret are set. One without
 * the other, or a malformed value, fails the boot: an operator who set half
 * of it meant to turn the feature on.
 */
import { z } from 'zod';
import { isSecureUrl } from '../artifacts/config';
import { DEFAULT_MODEL_ID } from '../core/llm';
import type { OracleWorkerEnv } from '../do/contracts';
import type { FeedbackIssue } from './contract';

/** Studio team and its "User Feedback from Portal" project. */
export const DEFAULT_FEEDBACK_LINEAR_TEAM_ID =
  'c781a53a-d432-469f-9c9c-2345a0f8243b';
export const DEFAULT_FEEDBACK_LINEAR_PROJECT_ID =
  '6c1474a9-620c-4e3c-b443-0263992f3b55';
export const DEFAULT_FEEDBACK_LINEAR_API_URL = 'https://api.linear.app/graphql';
export const FEEDBACK_HMAC_SECRET_MIN_CHARS = 32;

const linearId = z.uuid();

const FeedbackEnv = z.object({
  FEEDBACK_LINEAR_API_KEY: z.string().trim().min(1),
  FEEDBACK_HMAC_SECRET: z.string().min(FEEDBACK_HMAC_SECRET_MIN_CHARS),
  FEEDBACK_LINEAR_TEAM_ID: linearId.default(DEFAULT_FEEDBACK_LINEAR_TEAM_ID),
  FEEDBACK_LINEAR_PROJECT_ID: linearId.default(
    DEFAULT_FEEDBACK_LINEAR_PROJECT_ID,
  ),
  FEEDBACK_LINEAR_LABEL_IDS: z
    .string()
    .optional()
    .transform((raw) =>
      (raw ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    )
    .pipe(z.array(linearId)),
  FEEDBACK_LINEAR_API_URL: z
    .string()
    .refine(isSecureUrl, 'must be an https URL (http only on localhost)')
    .default(DEFAULT_FEEDBACK_LINEAR_API_URL),
  QIFORGE_BUILD_VERSION: z.string().trim().min(1).max(80).optional(),
});

export interface LinearDestination {
  apiUrl: string;
  apiKey: string;
  teamId: string;
  projectId: string;
  labelIds: string[];
}

export interface FeedbackConfig {
  hmacSecret: string;
  linear: LinearDestination;
  /** The coarse Agent context every issue carries. */
  agent: FeedbackIssue['agent'];
}

type FeedbackEnvSource = Pick<
  OracleWorkerEnv,
  | 'ORACLE_NAME'
  | 'ORACLE_DID'
  | 'ORACLE_ENTITY_DID'
  | 'DEFAULT_MODEL'
  | 'LLM_PROVIDER'
  | 'FEEDBACK_LINEAR_API_KEY'
  | 'FEEDBACK_HMAC_SECRET'
  | 'FEEDBACK_LINEAR_TEAM_ID'
  | 'FEEDBACK_LINEAR_PROJECT_ID'
  | 'FEEDBACK_LINEAR_LABEL_IDS'
  | 'FEEDBACK_LINEAR_API_URL'
  | 'QIFORGE_BUILD_VERSION'
>;

const blank = (value: string | undefined) => !value || !value.trim();

/**
 * Null when the feature is off. Throws when it is half-configured or a
 * value is malformed; the message names the keys, never their values.
 */
export function feedbackConfigFromEnv(
  env: FeedbackEnvSource,
): FeedbackConfig | null {
  const keyMissing = blank(env.FEEDBACK_LINEAR_API_KEY);
  const secretMissing = blank(env.FEEDBACK_HMAC_SECRET);
  if (keyMissing && secretMissing) return null;
  if (keyMissing || secretMissing)
    throw new Error(
      `Anonymous feedback is half-configured: set both FEEDBACK_LINEAR_API_KEY and FEEDBACK_HMAC_SECRET, or neither (missing: ${keyMissing ? 'FEEDBACK_LINEAR_API_KEY' : 'FEEDBACK_HMAC_SECRET'})`,
    );
  const parsed = FeedbackEnv.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Anonymous feedback configuration is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  const config = parsed.data;
  return {
    hmacSecret: config.FEEDBACK_HMAC_SECRET,
    linear: {
      apiUrl: config.FEEDBACK_LINEAR_API_URL,
      apiKey: config.FEEDBACK_LINEAR_API_KEY,
      teamId: config.FEEDBACK_LINEAR_TEAM_ID,
      projectId: config.FEEDBACK_LINEAR_PROJECT_ID,
      labelIds: config.FEEDBACK_LINEAR_LABEL_IDS,
    },
    agent: {
      did: env.ORACLE_ENTITY_DID || env.ORACLE_DID,
      name: env.ORACLE_NAME,
      model: env.DEFAULT_MODEL || DEFAULT_MODEL_ID,
      provider: env.LLM_PROVIDER ?? 'openrouter',
      runtimeBuildVersion: config.QIFORGE_BUILD_VERSION ?? 'unknown',
    },
  };
}
