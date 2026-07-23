import {
  cosmos,
  createQueryClient,
  createRegistry,
  ixo,
  type QueryClient,
  utils,
} from '@ixo/impactxclient-sdk';
import { gqlClient } from '../../gql/index.js';
import { addDays } from '../../utils/general.js';
import { getSettingsResource } from '../../utils/get-settings-resouce.js';
import { ValidationError } from '../../utils/validation-error.js';
import {
  type AuthorizationType,
  type GetOracleAuthZConfigParams,
  type GrantClaimSubmitAuthorizationParams,
  type IAuthzConfig,
  type Permission,
  type TransactionFn,
  validateAuthzConfig,
} from './types.js';

/**
 * Default lifetime of a claim intent, in nanoseconds (1 hour).
 *
 * When an agent reserves payment for a job, the chain escrows the funds and
 * holds them for this long. If no claim is submitted before the window closes,
 * the chain releases the reservation and returns the funds to the payer.
 *
 * This is also how long a user stays blocked after abandoning a job: only one
 * intent can be active at a time for a given agent and claim collection, and
 * there is no way to cancel one early, so the user cannot start another paid
 * job with that oracle until the window expires.
 */
export const DEFAULT_INTENT_DURATION_NS = (1_000_000_000 * 60 * 60).toString();

export class Authz {
  constructor(
    private readonly config: IAuthzConfig,
    private readonly queryClientPromise: Promise<QueryClient> = createQueryClient(
      process.env.RPC_URL ??
        (process.env.NEXT_PUBLIC_RPC_URL as string) ??
        'https://devnet.ixo.earth/rpc/',
    ),
    private readonly logger: {
      info: (message: string, ...meta: unknown[]) => void;
      error: (message: string, ...meta: unknown[]) => void;
      warn: (message: string, ...meta: unknown[]) => void;
    } = {
      info: (message: string, ...meta: unknown[]) => {
        // eslint-disable-next-line no-console
        console.info(message, ...meta);
      },
      error: (message: string, ...meta: unknown[]) => {
        // eslint-disable-next-line no-console
        console.error(message, ...meta);
      },
      warn: (message: string, ...meta: unknown[]) => {
        // eslint-disable-next-line no-console
        console.warn(message, ...meta);
      },
    },
  ) {
    if (!process.env.RPC_URL && !process.env.NEXT_PUBLIC_RPC_URL) {
      // eslint-disable-next-line no-console
      console.warn(
        'RPC_URL is not set, using default testnet RPC URL',
        'RPC_URL',
        process.env.RPC_URL,
        'NEXT_PUBLIC_RPC_URL',
        process.env.NEXT_PUBLIC_RPC_URL,
      );
    }
    this.config = validateAuthzConfig(config);
  }

  /**
   * Grants the permissions to the grantee address
   * @param overrideConfig - Optional override config
   * @returns The generic and send authorizations
   */
  public async grant(
    sign: TransactionFn,
    overrideConfig?: Partial<IAuthzConfig>,
  ) {
    const {
      granteeAddress,
      granterAddress,
      oracleName,
      expirationDays = 30,
      spendLimit,
      requiredPermissions,
    } = {
      ...this.config,
      ...overrideConfig,
    };

    const genericAuthorization = [];
    const sendAuthorization = [];

    for (const permission of requiredPermissions) {
      const payload = {
        // client
        spendLimit,
        granterAddress,
        // server
        granteeAddress,
        oracleName,
        expirationDays,
        permission,
      };
      if (this.shouldUseSendAuthorization(permission)) {
        sendAuthorization.push(Authz.createMsgGrantSend(payload));
      } else {
        genericAuthorization.push(Authz.createMsgGrantAuthz(payload));
      }
    }

    const tx = await sign(
      [...genericAuthorization, ...sendAuthorization],
      `Grant Authorization ${oracleName}`,
    );
    return tx;
  }
  public async getUserGrants(userClaimCollectionId: string) {
    if (!userClaimCollectionId) {
      throw new ValidationError('User has no oracles claim collection');
    }
    const queryClient = await this.queryClientPromise;
    const claimCollection = await gqlClient.getClaimCollection({
      claimCollectionId: userClaimCollectionId,
    });
    const entityAdmin = claimCollection?.claimCollection?.admin;
    if (!entityAdmin) {
      throw new ValidationError('Entity has no admin');
    }

    // Fetch all grants where our address is the grantee (receiver of permissions)
    const granteeGrants = await queryClient.cosmos.authz.v1beta1.granteeGrants({
      grantee: this.config.granteeAddress,
    });

    // Array to collect the permissions we have
    const permissions: Permission<AuthorizationType>[] = [];

    // Process each grant
    for (const grant of granteeGrants.grants) {
      const granteeAddress = grant.grantee;
      const granterAddress = grant.granter;
      const authorization = grant.authorization;
      const expiration = grant.expiration;
      if (!authorization) {
        continue;
      }

      // Check if the grant is expired
      const isExpired = expiration
        ? new Date(expiration.seconds.toNumber() * 1000) < new Date()
        : false;

      if (isExpired) {
        continue;
      }

      // Check if the grant is for the correct granter and grantee
      if (
        grant.granter !== entityAdmin ||
        grant.grantee !== this.config.granteeAddress
      ) {
        continue;
      }

      // Handle different authorization types
      try {
        // Decode the authorization based on its type
        switch (authorization.typeUrl) {
          case '/cosmos.authz.v1beta1.GenericAuthorization': {
            const decoded = cosmos.authz.v1beta1.GenericAuthorization.decode(
              authorization.value,
            );
            permissions.push({
              msgTypeUrl: decoded.msg,
              granter: granterAddress,
              grantee: granteeAddress,
              expiration: expiration
                ? new Date(expiration.seconds.toNumber() * 1000)
                : null,
            } satisfies Permission<'/cosmos.authz.v1beta1.GenericAuthorization'>);
            break;
          }
          case '/cosmos.bank.v1beta1.SendAuthorization': {
            const decoded = cosmos.bank.v1beta1.SendAuthorization.decode(
              authorization.value,
            );
            permissions.push({
              msgTypeUrl: authorization.typeUrl,
              spendLimit: decoded.spendLimit,
              granter: granterAddress,
              grantee: granteeAddress,
              expiration: expiration
                ? new Date(expiration.seconds.toNumber() * 1000)
                : null,
            } satisfies Permission<'/cosmos.bank.v1beta1.SendAuthorization'>);
            break;
          }

          case '/ixo.claims.v1beta1.SubmitClaimAuthorization': {
            // Decode submit claim authorization

            const decoded = ixo.claims.v1beta1.SubmitClaimAuthorization.decode(
              authorization.value,
            );

            permissions.push({
              msgTypeUrl: authorization.typeUrl,
              admin: decoded.admin,
              constraints: decoded.constraints,
              granter: granterAddress,
              grantee: granteeAddress,
              expiration: expiration
                ? new Date(expiration.seconds.toNumber() * 1000)
                : null,
            } satisfies Permission<'/ixo.claims.v1beta1.SubmitClaimAuthorization'>);
            break;
          }
          // Add more authorization types as needed
          default:
            try {
              const registry = createRegistry();
              const typeUrl = authorization.typeUrl;
              const decoded = registry.decode({
                typeUrl,
                value: authorization.value,
              });
              this.logger.warn(
                'Unknown authorization type: ' + authorization.typeUrl,
                decoded,
              );
              permissions.push({
                msgTypeUrl:
                  authorization.typeUrl as '/ixo.claims.v1beta1.SubmitClaimAuthorization',
                admin: decoded?.admin,
                constraints: decoded?.constraints,
                granter: granterAddress,
                grantee: granteeAddress,
                expiration: expiration
                  ? new Date(expiration.seconds.toNumber() * 1000)
                  : null,
              } satisfies Permission<'/ixo.claims.v1beta1.SubmitClaimAuthorization'>);
              break;
            } catch (_error) {
              this.logger.error(
                `Unknown authorization type: ${authorization.typeUrl}`,
              );
              break;
            }
        }
      } catch (error: unknown) {
        if (error instanceof Error) {
          this.logger.error(`Error decoding authorization: ${error.message}`);
        } else {
          this.logger.error(`Error decoding authorization: ${String(error)}`);
        }
      }
    }
    return permissions;
  }
  public async hasPermission(
    msgTypeUrl: string | string[],
    userClaimCollectionId: string,
  ) {
    if (!userClaimCollectionId) {
      throw new ValidationError('User has no oracles claim collection');
    }
    const permissions = await this.getUserGrants(userClaimCollectionId);
    const permissionsToCheck = Array.isArray(msgTypeUrl)
      ? msgTypeUrl
      : [msgTypeUrl];
    return permissions.every((p) => permissionsToCheck.includes(p.msgTypeUrl));
  }

  public async grantClaimSubmitAuthorization(
    params: GrantClaimSubmitAuthorizationParams,
    sign: TransactionFn,
  ) {
    const {
      oracleAddress,
      oracleName,
      accountAddress,
      adminAddress,
      claimCollectionId,
      maxAmount,
      agentQuota,
      intentDurationNs = DEFAULT_INTENT_DURATION_NS,
    } = params;

    const message = {
      typeUrl: '/cosmos.authz.v1beta1.MsgExec',
      value: cosmos.authz.v1beta1.MsgExec.fromPartial({
        grantee: accountAddress,
        msgs: [
          {
            typeUrl: '/ixo.claims.v1beta1.MsgCreateClaimAuthorization',
            value: ixo.claims.v1beta1.MsgCreateClaimAuthorization.encode(
              ixo.claims.v1beta1.MsgCreateClaimAuthorization.fromPartial({
                creatorAddress: accountAddress,
                creatorDid: `did:ixo:${accountAddress}`,
                adminAddress,
                granteeAddress: oracleAddress,
                collectionId: claimCollectionId,
                agentQuota: utils.proto.numberToLong(agentQuota),
                intentDurationNs: utils.proto.toDuration(intentDurationNs),
                maxAmount,

                authType:
                  ixo.claims.v1beta1.CreateClaimAuthorizationType.SUBMIT,
              }),
            ).finish(),
          },
        ],
      }),
    };
    return sign([message], `Grant Claim Submit Authorization ${oracleName}`);
  }

  public async contractOracle(
    params: GrantClaimSubmitAuthorizationParams,
    sign: TransactionFn,
  ) {
    await this.grantClaimSubmitAuthorization(params, sign);
  }

  public async grantAllPermissions(sign: TransactionFn) {
    await this.grant(sign);
  }

  static createMsgGrantAuthz(
    payload: Pick<
      IAuthzConfig,
      'granterAddress' | 'granteeAddress' | 'oracleName' | 'expirationDays'
    > & {
      permission: string;
    },
  ) {
    return {
      typeUrl: '/cosmos.authz.v1beta1.MsgGrant',
      value: cosmos.authz.v1beta1.MsgGrant.fromPartial({
        granter: payload.granterAddress,
        grantee: payload.granteeAddress,
        grant: cosmos.authz.v1beta1.Grant.fromPartial({
          authorization: {
            typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
            value: cosmos.authz.v1beta1.GenericAuthorization.encode(
              cosmos.authz.v1beta1.GenericAuthorization.fromPartial({
                msg: payload.permission,
              }),
            ).finish(),
          },
          expiration: utils.proto.toTimestamp(
            addDays(new Date(), payload.expirationDays ?? 30),
          ),
        }),
      }),
    };
  }
  static createMsgExecAuthZ(
    payload: Pick<IAuthzConfig, 'granteeAddress'> & {
      messages: {
        typeUrl: string;
        value: Uint8Array;
      }[];
    },
  ) {
    return {
      typeUrl: '/cosmos.authz.v1beta1.MsgExec',
      value: cosmos.authz.v1beta1.MsgExec.fromPartial({
        grantee: payload.granteeAddress,
        msgs: payload.messages,
      }),
    };
  }

  static createMsgGrantSend(
    payload: Pick<
      IAuthzConfig,
      | 'granterAddress'
      | 'granteeAddress'
      | 'oracleName'
      | 'expirationDays'
      | 'spendLimit'
    >,
  ) {
    return {
      typeUrl: '/cosmos.authz.v1beta1.MsgGrant',
      value: cosmos.authz.v1beta1.MsgGrant.fromPartial({
        granter: payload.granterAddress,
        grantee: payload.granteeAddress,
        grant: cosmos.authz.v1beta1.Grant.fromPartial({
          authorization: {
            typeUrl: '/cosmos.bank.v1beta1.SendAuthorization',
            value: cosmos.bank.v1beta1.SendAuthorization.encode(
              cosmos.bank.v1beta1.SendAuthorization.fromPartial({
                spendLimit: payload.spendLimit?.map((spendLimit) =>
                  cosmos.base.v1beta1.Coin.fromPartial({
                    amount: spendLimit.amount,
                    denom: spendLimit.denom,
                  }),
                ),
              }),
            ).finish(),
          },
          expiration: utils.proto.toTimestamp(
            addDays(new Date(), payload.expirationDays ?? 30),
          ),
        }),
      }),
    };
  }
  static createMsgExecSend(
    payload: Pick<
      IAuthzConfig,
      'granterAddress' | 'granteeAddress' | 'oracleName' | 'expirationDays'
    > & {
      amounts: {
        amount: string;
        denom: string;
      }[];
    },
  ) {
    return {
      typeUrl: '/cosmos.authz.v1beta1.MsgExec',
      value: cosmos.authz.v1beta1.MsgExec.fromPartial({
        grantee: payload.granteeAddress,
        msgs: [
          {
            typeUrl: '/cosmos.bank.v1beta1.MsgSend',
            value: cosmos.bank.v1beta1.MsgSend.encode(
              cosmos.bank.v1beta1.MsgSend.fromPartial({
                amount: payload.amounts?.map((amount) =>
                  cosmos.base.v1beta1.Coin.fromPartial({
                    amount: amount.amount,
                    denom: amount.denom,
                  }),
                ),
                fromAddress: payload.granterAddress,
                toAddress: payload.granteeAddress,
              }),
            ).finish(),
          },
        ],
      }),
    };
  }
  static async getOracleAuthZConfig(
    params: GetOracleAuthZConfigParams,
  ): Promise<IAuthzConfig> {
    const config = await getSettingsResource(
      {
        protocolDid: params.oracleDid,
        id: '{id}#orz',
      },
      params.matrixAccessToken,
      params.matrixHomeServer,
    );
    if (!params.granterAddress) {
      throw new ValidationError(
        'Missing granterAddress: Please provide a granterAddress.',
      );
    }
    const validConfig = validateAuthzConfig(config, false);
    return {
      ...validConfig,
      granterAddress: params.granterAddress,
    };
  }

  private shouldUseSendAuthorization(permission: string) {
    const sendMsgTypes = [
      // MsgSend - Allows transferring tokens from one account to another
      '/cosmos.bank.v1beta1.MsgSend',
      // MsgMultiSend - Allows transferring tokens from one or more input accounts to one or more output accounts
      '/cosmos.bank.v1beta1.MsgMultiSend',
    ];
    return sendMsgTypes.includes(permission);
  }
}
