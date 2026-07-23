import { type Coin, type EncodeObject } from '@cosmjs/proto-signing';
import { type DeliverTxResponse } from '@cosmjs/stargate';
import { type SubmitClaimAuthorization } from '@ixo/impactxclient-sdk/codegen/ixo/claims/v1beta1/authz';
import z from 'zod';
import { ValidationError } from '../../utils/validation-error.js';

/**
 * Configuration interface for Cosmos SDK Authorization (authz) operations.
 * Defines the necessary parameters for granting and managing permissions
 * between accounts in the blockchain network.
 */
export interface IAuthzConfig {
  /**
   * Array of message types that the grantee will be authorized to execute.
   * Each string represents a specific operation type (e.g., "/cosmos.bank.v1beta1.MsgSend"
   * for token transfers or "/ixo.entity.v1beta1.MsgCreateEntity" for entity creation).
   * The grantee will only be able to perform operations corresponding to these message types.
   */
  requiredPermissions: string[];

  /**
   * The blockchain address of the account granting permissions.
   * This address will be authorizing another account (grantee) to act on its behalf.
   */
  granterAddress?: string;
  /**
   * The ixo address of the account receiving permissions.
   * This address will be authorized to perform specified actions on behalf of the granter.
   */
  granteeAddress: string;

  /**
   * Duration in days for which the authorization will remain valid.
   * After this period expires, the granted permissions will no longer be valid.
   * If not specified, a default expiration period will be applied.
   * @default 30 days
   */
  expirationDays?: number;

  /**
   * Optional spending limit for financial operations.
   * Only applicable for certain authorization types like SendAuthorization.
   * Specified as an array of coin objects with denom and amount.
   */
  spendLimit?: Array<{ denom: string; amount: string }>;

  /**
   * name or identifier for this authorization grant.
   * Useful for tracking and managing multiple authorization relationships.
   */
  oracleName: string;
}

/**
 * Zod schema for the IAuthzConfig interface.
 * Provides runtime validation for authorization configuration.
 */
export const AuthzConfigSchema = z.object({
  requiredPermissions: z.array(z.string()),

  granteeAddress: z.string().min(1, {
    message: 'Grantee address is required',
  }),

  granterAddress: z.string().min(1, {
    message: 'Granter address is required',
  }),

  oracleName: z.string().min(1, {
    message: 'Oracle name is required',
  }),

  expirationDays: z.number().optional(),

  /**
   * Optional spending limit for financial operations.
   * Only applicable for certain authorization types like SendAuthorization.
   * Specified as an array of coin objects with denom and amount.
   */
  spendLimit: z
    .array(
      z.object({
        denom: z.string(),
        amount: z.string().regex(/^\d+$/, {
          message: 'Amount must be a string of digits',
        }),
      }),
    )
    .optional(),
});

/**
 * Validate an authorization configuration object
 * @param config The config to validate
 * @returns The validated config (with types properly inferred)
 * @throws If validation fails
 */
export function validateAuthzConfig(
  config: unknown,
  checkGranterAddress = true,
): IAuthzConfig {
  const schema = checkGranterAddress
    ? AuthzConfigSchema
    : AuthzConfigSchema.omit({ granterAddress: true });
  const result = schema.safeParse(config);
  if (!result.success) {
    throw ValidationError.fromZodError(result.error);
  }
  return result.data;
}

export type TransactionFn = (
  messages: readonly EncodeObject[],
  memo?: string,
) => Promise<DeliverTxResponse | undefined>;

export type AuthorizationType =
  | '/cosmos.authz.v1beta1.GenericAuthorization'
  | '/cosmos.bank.v1beta1.SendAuthorization'
  | '/ixo.claims.v1beta1.SubmitClaimAuthorization';

type SendAuthorizationPermissionPayload = {
  spendLimit: Array<{ denom: string; amount: string }>;
  allowList?: Array<string>;
};
type SubmitClaimAuthorizationPermissionPayload = {
  admin: string;
  constraints: SubmitClaimAuthorization['constraints'];
};

export type Permission<T extends AuthorizationType> = {
  msgTypeUrl: T extends '/cosmos.authz.v1beta1.GenericAuthorization'
    ? string
    : T;
  granter: string;
  grantee: string;
  expiration: Date | null;
} & (T extends '/cosmos.bank.v1beta1.SendAuthorization'
  ? SendAuthorizationPermissionPayload
  : T extends '/ixo.claims.v1beta1.SubmitClaimAuthorization'
    ? SubmitClaimAuthorizationPermissionPayload
    : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
      {});

export type GetOracleAuthZConfigParams = {
  oracleDid: string;
  granterAddress: string;
  customConfigName?: string;
  matrixAccessToken?: string;
  matrixHomeServer?: string;
};

export type GrantClaimSubmitAuthorizationParams = {
  claimCollectionId: string;
  accountAddress: string;
  oracleAddress: string;
  agentQuota: number;
  oracleName: string;
  adminAddress: string;
  maxAmount?: Coin[];
  /**
   * How long each claim intent created under this authorization stays alive,
   * in nanoseconds, as a decimal string. Defaults to
   * `DEFAULT_INTENT_DURATION_NS` (1 hour) when omitted.
   *
   * Set a longer window only when the contracted work genuinely takes longer
   * than the default: an intent cannot be renewed or cancelled once created, so
   * a job that outlives its window loses its escrowed payment reservation
   * mid-flight. Agree the longer window up front rather than trying to replace
   * an expired intent while the job is running.
   */
  intentDurationNs?: string;
};
