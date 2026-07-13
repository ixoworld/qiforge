import { Claims, Client, Payments } from '@ixo/oracles-chain-client';
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { getSubscriptionUrlByNetwork } from '@ixo/common';
import { SqliteSaver } from '@ixo/sqlite-saver';
import {
  entrypoint,
  task,
  type BaseCheckpointSaver,
} from '@langchain/langgraph';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { UcanService } from '../../modules/ucan/ucan.service.js';
import { TokenLimiter } from './token-limiter.js';

/** Token used to inject the credits-plugin TokenLimiter instance into the service. */
export const CLAIM_PROCESSING_TOKEN_LIMITER = Symbol.for(
  'ClaimProcessingTokenLimiter',
);

export interface UsageClaim {
  amount: number;
  oracleDid: string;
  oracleEntityDid: string;
  userDid: string;
  service: string;
  oracleName: string;
}

/** IBC denom representing uixo on mainnet. */
const MAINNET_IBC_DENOM =
  'ibc/6BBE9BD4246F8E04948D5A4EEE7164B2630263B9EBB5E7DC5F0A46C62A2FF97B';

type Denom = 'uixo' | typeof MAINNET_IBC_DENOM;

interface ClaimProcessingConfig {
  ORACLE_DID: string;
  ORACLE_ENTITY_DID: string;
  ORACLE_NAME: string;
  NETWORK: 'mainnet' | 'testnet' | 'devnet';
  SQLITE_DATABASE_PATH: string;
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: string;
  MATRIX_ACCOUNT_ROOM_ID?: string;
  MATRIX_VALUE_PIN: string;
  SECP_MNEMONIC: string;
  SUBSCRIPTION_URL?: string;
  // Raw env string — ConfigService reads process.env before the validated
  // (coerced) config, so this is never a boolean here.
  DISABLE_CREDITS?: string;
  // Minimum held credits before a claim is settled on-chain. Arrives as a
  // raw string when set in process.env, or the zod-coerced number (from the
  // loaded validated config) when unset. Parsed defensively at boot.
  MINIMUM_CLAIM_THRESHOLD?: string | number;
}

interface ProcessClaimParams {
  userDid: string;
  heldAmount: number;
  subscription: {
    adminAddress: string;
    claimCollections: {
      oracleClaimsCollectionId: string;
    };
    totalCredits: number;
  };
  internalClaimId: string;
  denom: Denom;
  configService: ConfigService<ClaimProcessingConfig>;
}

interface SplitContext {
  index: number;
  total: number;
  originalAmount: number;
}

/**
 * Default minimum held credits before submitting a claim (prevents spam of
 * tiny txns). Overridable per-oracle via the `MINIMUM_CLAIM_THRESHOLD` env var.
 */
const DEFAULT_MINIMUM_CLAIM_THRESHOLD = 1000;

/** Log prefix for the whole claim-settlement flow — grep this to trace it end-to-end. */
const LOG_TAG = '[Credits/Claims]';

/**
 * Submits held-credit claims to the chain on a fixed cron. Pulls users with
 * non-zero held amounts from the credits-plugin `TokenLimiter`, then runs a
 * LangGraph `entrypoint`+`task` workflow per user:
 *
 *   1. submit intent (escrow payment)
 *   2. sign + save the claim to Matrix
 *   3. submit the claim on-chain
 *   4. notify the subscription API
 *
 * Splits oversized batches against the oracle's per-claim max. Internal,
 * agent-invisible — `claimProcessingPlugin` declares `visibility: 'silent'`
 * and ships no tools.
 */
@Injectable()
export class ClaimProcessingService {
  private readonly logger = new Logger(ClaimProcessingService.name);
  private readonly denom: Denom;
  private readonly claimProcessingCheckpointer: BaseCheckpointSaver;
  private readonly claimProcessingDbPath: string;
  private readonly tokenLimiter: TokenLimiter;
  private readonly minimumClaimThreshold: number;

  private readonly retryPolicy = {
    maxAttempts: 3,
    backoffFactor: 2,
    initialInterval: 1000,
  };

  constructor(
    private readonly configService: ConfigService<ClaimProcessingConfig>,
    private readonly ucanService: UcanService,
    @Optional()
    @Inject(CLAIM_PROCESSING_TOKEN_LIMITER)
    tokenLimiter?: TokenLimiter,
  ) {
    if (!tokenLimiter) {
      throw new Error(
        'ClaimProcessingService requires a TokenLimiter instance (provide via the CLAIM_PROCESSING_TOKEN_LIMITER token).',
      );
    }
    this.tokenLimiter = tokenLimiter;

    this.denom =
      this.configService.get('NETWORK') === 'mainnet'
        ? MAINNET_IBC_DENOM
        : 'uixo';

    this.minimumClaimThreshold = this.resolveMinimumClaimThreshold();

    this.logger.log(
      `${LOG_TAG} Claim processing initialized: network=${this.configService.get(
        'NETWORK',
      )} denom=${this.denom} minimumClaimThreshold=${this.minimumClaimThreshold} disableCredits=${
        this.configService.get('DISABLE_CREDITS') ?? 'false'
      } matrixAccountRoomId=${this.configService.get('MATRIX_ACCOUNT_ROOM_ID') ? 'set' : 'MISSING'}`,
    );

    const sqlitePath = this.configService.getOrThrow('SQLITE_DATABASE_PATH');
    const claimProcessingFolder = path.join(sqlitePath, 'claim_processing');
    this.claimProcessingDbPath = path.join(
      claimProcessingFolder,
      'claim-processing.db',
    );

    try {
      mkdirSync(claimProcessingFolder, { recursive: true });
    } catch (err) {
      this.logger.error(
        `Failed to create claim processing folder: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
    }

    const sqliteSaver = SqliteSaver.fromConnString(this.claimProcessingDbPath);
    this.claimProcessingCheckpointer =
      sqliteSaver as unknown as BaseCheckpointSaver;
  }

  /**
   * Resolve the minimum held-credits threshold from config. Accepts a raw env
   * string (process.env precedence) or the zod-coerced number (from the loaded
   * validated config); falls back to {@link DEFAULT_MINIMUM_CLAIM_THRESHOLD}
   * when unset or invalid.
   */
  private resolveMinimumClaimThreshold(): number {
    const raw = this.configService.get('MINIMUM_CLAIM_THRESHOLD');
    if (raw === undefined || raw === null || raw === '') {
      return DEFAULT_MINIMUM_CLAIM_THRESHOLD;
    }

    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.logger.warn(
        `${LOG_TAG} Invalid MINIMUM_CLAIM_THRESHOLD="${String(raw)}"; falling back to default ${DEFAULT_MINIMUM_CLAIM_THRESHOLD}`,
      );
      return DEFAULT_MINIMUM_CLAIM_THRESHOLD;
    }

    return Math.round(parsed);
  }

  /**
   * Slice `heldAmount` into chunks no larger than `maxAmount`. Used when the
   * total held amount exceeds the oracle's per-claim ceiling.
   */
  private calculateSplits(heldAmount: number, maxAmount: number): number[] {
    if (heldAmount <= maxAmount) {
      return [heldAmount];
    }

    const splits: number[] = [];
    let remaining = heldAmount;
    while (remaining > 0) {
      const chunk = Math.min(remaining, maxAmount);
      splits.push(chunk);
      remaining -= chunk;
    }
    return splits;
  }

  /** Step 1 of the workflow: pay the user's claim collection escrow. */
  private submitIntentTask = task(
    {
      name: 'submitIntent',
      retry: this.retryPolicy,
    },
    async (params: ProcessClaimParams) => {
      this.logger.log(
        `${LOG_TAG} [step 1/4 submitIntent] user=${params.userDid} amount=${params.heldAmount} denom=${params.denom} — sending payment to escrow`,
      );

      const collectionId =
        params.subscription.claimCollections.oracleClaimsCollectionId;
      if (!collectionId) {
        throw new Error('Oracle claims collection ID not found');
      }

      const paymentsClient = new Payments();

      const hasActiveIntent = await paymentsClient.checkForActiveIntent({
        userClaimCollection: collectionId,
        granteeAddress: params.configService
          .getOrThrow('ORACLE_DID')
          .replace('did:ixo:', ''),
      });

      if (hasActiveIntent) {
        this.logger.log(
          `${LOG_TAG} [step 1/4 submitIntent] user=${params.userDid} already has an active intent — reusing it, skipping escrow payment`,
        );
        return { success: true, transactionHash: null };
      }

      const intent = await paymentsClient.sendPaymentToEscrow({
        amount: {
          amount: params.heldAmount.toString(),
          denom: params.denom,
        },
        userClaimCollection: collectionId,
      });

      if (intent.code !== 0) {
        this.logger.error(
          `${LOG_TAG} [step 1/4 submitIntent] FAILED user=${params.userDid} code=${intent.code}: ${intent.rawLog || 'Unknown error'}`,
        );
        throw new Error(
          `Failed to send payment to escrow: ${intent.rawLog || 'Unknown error'}`,
        );
      }

      this.logger.log(
        `${LOG_TAG} [step 1/4 submitIntent] OK user=${params.userDid} intentTxHash=${intent.transactionHash}`,
      );

      return { success: true, transactionHash: intent.transactionHash };
    },
  );

  /** Step 2: build a signed claim and stash it in the oracle's Matrix room. */
  private saveToMatrixTask = task(
    {
      name: 'saveToMatrix',
      retry: this.retryPolicy,
    },
    async (params: ProcessClaimParams) => {
      this.logger.log(
        `${LOG_TAG} [step 2/4 saveToMatrix] user=${params.userDid} amount=${params.heldAmount} — signing claim and saving to Matrix`,
      );

      const collectionId =
        params.subscription.claimCollections.oracleClaimsCollectionId;
      if (!collectionId) {
        throw new Error('Oracle claims collection ID not found');
      }

      const client = Client.getInstance();
      await client.init();
      const claimsClient = new Claims(client);

      // Reuse the signing mnemonic that boot already pulled out of the
      // oracle's Matrix account room. When this is null (cron tick beat the
      // post-Matrix-init boot wiring), fall back to the original lookup so
      // the claim still goes through.
      const cachedSigningMnemonic = this.ucanService.getSigningMnemonic();
      if (!cachedSigningMnemonic) {
        this.logger.warn(
          'Signing mnemonic not yet loaded by UcanService; falling back to per-claim Matrix lookup for this run',
        );
      }

      const cid = await claimsClient.saveSignedClaimToMatrix({
        accessToken: params.configService.getOrThrow(
          'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
        ),
        claim: {
          amount: [
            {
              amount: params.heldAmount.toString(),
              denom: params.denom,
            },
          ],
          body: {
            amount: params.heldAmount,
            oracleDid: params.configService.getOrThrow('ORACLE_DID'),
            oracleEntityDid:
              params.configService.getOrThrow('ORACLE_ENTITY_DID'),
            service: `Chatting With AI ${params.configService.getOrThrow('ORACLE_NAME')}`,
            oracleName: params.configService.getOrThrow('ORACLE_NAME'),
            userDid: params.userDid,
          } satisfies UsageClaim,
        },
        collectionId,
        matrixRoomId: params.configService.get('MATRIX_ACCOUNT_ROOM_ID') ?? '',
        secpMnemonic: params.configService.getOrThrow('SECP_MNEMONIC'),
        matrixValuePin: params.configService.getOrThrow('MATRIX_VALUE_PIN'),
        oracleDid: params.configService.getOrThrow('ORACLE_DID'),
        network: params.configService.getOrThrow('NETWORK'),
        decryptedSigningMnemonic: cachedSigningMnemonic ?? undefined,
      });

      this.logger.log(
        `${LOG_TAG} [step 2/4 saveToMatrix] OK user=${params.userDid} claimCid=${cid}`,
      );

      return { cid };
    },
  );

  /** Step 3: submit the signed claim on-chain against the user's collection. */
  private submitToChainTask = task(
    {
      name: 'submitToChain',
      retry: this.retryPolicy,
    },
    async (params: ProcessClaimParams & { cid: string }) => {
      this.logger.log(
        `${LOG_TAG} [step 3/4 submitToChain] user=${params.userDid} claimCid=${params.cid} amount=${params.heldAmount} — submitting on-chain`,
      );

      const collectionId =
        params.subscription.claimCollections.oracleClaimsCollectionId;
      if (!collectionId) {
        throw new Error('Oracle claims collection ID not found');
      }

      const client = Client.getInstance();
      await client.init();
      const claimsClient = new Claims(client);

      const result = await claimsClient.submitClaim({
        claimId: params.cid,
        collectionId,
        useIntent: true,
        amount: [
          {
            amount: params.heldAmount.toString(),
            denom: params.denom,
          },
        ],
      });

      if (result.code !== 0) {
        this.logger.error(
          `${LOG_TAG} [step 3/4 submitToChain] FAILED user=${params.userDid} claimCid=${params.cid} code=${result.code}: ${result.rawLog || 'Unknown error'}`,
        );
        throw new Error(
          `Failed to submit claim to chain: ${result.rawLog || 'Unknown error'}`,
        );
      }

      this.logger.log(
        `${LOG_TAG} [step 3/4 submitToChain] OK user=${params.userDid} claimCid=${params.cid} chainTxHash=${result.transactionHash}`,
      );

      return { success: true, transactionHash: result.transactionHash };
    },
  );

  /** Step 4: notify the subscription API so it can update the user's balance. */
  private sendToSubsApiTask = task(
    {
      name: 'sendToSubsApi',
      retry: this.retryPolicy,
    },
    async (params: ProcessClaimParams & { cid: string }) => {
      const subscriptionUrl =
        this.configService.get('SUBSCRIPTION_URL') ??
        getSubscriptionUrlByNetwork(params.configService.getOrThrow('NETWORK'));

      this.logger.log(
        `${LOG_TAG} [step 4/4 sendToSubsApi] user=${params.userDid} claimCid=${params.cid} — notifying subscription API at ${subscriptionUrl}`,
      );

      await submitClaimToSubscriptionApi(subscriptionUrl, params.cid);

      this.logger.log(
        `${LOG_TAG} [step 4/4 sendToSubsApi] OK user=${params.userDid} claimCid=${params.cid}`,
      );

      return { success: true };
    },
  );

  /**
   * Per-call factory so the langgraph `entrypoint` always picks up the
   * checkpointer initialized in `constructor`.
   */
  private getProcessClaimWorkflow() {
    return entrypoint(
      {
        checkpointer: this.claimProcessingCheckpointer,
        name: 'processClaim',
      },
      async (params: ProcessClaimParams) => {
        await this.submitIntentTask(params);
        const { cid } = await this.saveToMatrixTask(params);
        await this.submitToChainTask({ ...params, cid });
        await this.sendToSubsApiTask({ ...params, cid });
        return { success: true, cid };
      },
    );
  }

  /**
   * Cron-triggered processor — walks users above the minimum held-credits
   * threshold, splits oversized batches against the oracle's per-claim max,
   * and runs the 4-step claim workflow for each. Errors are logged and
   * isolated per-user so one user's failure doesn't stall the batch.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processHeldAmount(): Promise<void> {
    const matrixAccountRoomId = this.configService.get(
      'MATRIX_ACCOUNT_ROOM_ID',
    );
    // The env var is a string — `Boolean('false')` is true, so compare
    // against the literal instead of truthiness.
    const disableCredits =
      this.configService.get('DISABLE_CREDITS') === 'true' ||
      !matrixAccountRoomId;
    if (disableCredits) {
      this.logger.debug(
        matrixAccountRoomId
          ? `${LOG_TAG} Cron tick skipped (DISABLE_CREDITS=true)`
          : `${LOG_TAG} Cron tick skipped (MATRIX_ACCOUNT_ROOM_ID not set)`,
      );
      return;
    }

    const users = await this.tokenLimiter.listUsersWithHeldAmount(
      this.minimumClaimThreshold,
    );
    this.logger.log(
      `${LOG_TAG} Cron tick: ${users.length} user(s) at/above threshold ${this.minimumClaimThreshold} — starting settlement`,
    );

    let submitted = 0;
    let skipped = 0;
    let failed = 0;

    for (const [userDid, rawHeldAmount] of users) {
      try {
        const heldAmount = Math.round(rawHeldAmount);
        this.logger.log(
          `${LOG_TAG} user=${userDid} heldAmount=${heldAmount} — evaluating`,
        );
        if (heldAmount < this.minimumClaimThreshold) {
          this.logger.debug(
            `${LOG_TAG} SKIP user=${userDid} heldAmount=${heldAmount} below threshold ${this.minimumClaimThreshold}`,
          );
          skipped++;
          continue;
        }

        const subscription =
          await this.tokenLimiter.getSubscriptionPayload(userDid);
        if (!subscription) {
          this.logger.warn(
            `${LOG_TAG} SKIP user=${userDid} — no subscription payload found in Redis`,
          );
          skipped++;
          continue;
        }

        if (!subscription.claimCollections.oracleClaimsCollectionId) {
          this.logger.warn(
            `${LOG_TAG} SKIP user=${userDid} — subscription has no oracleClaimsCollectionId`,
          );
          skipped++;
          continue;
        }

        const availableCredits = subscription.totalCredits;
        if (availableCredits < heldAmount) {
          this.logger.warn(
            `${LOG_TAG} SKIP user=${userDid} — insufficient available credits (available=${availableCredits} < held=${heldAmount})`,
          );
          skipped++;
          continue;
        }

        const oracleEntityDid =
          this.configService.getOrThrow('ORACLE_ENTITY_DID');
        const oraclePricingList =
          await Payments.getOraclePricingList(oracleEntityDid);
        this.logger.log(
          `${LOG_TAG} user=${userDid} pricing: fetched on-chain oracle pricing list for entity=${oracleEntityDid} → ${JSON.stringify(
            oraclePricingList,
          )}`,
        );
        const maxAllowedClaimAmount = oraclePricingList.find(
          (item) => item.denom === this.denom,
        )?.amount;

        if (!maxAllowedClaimAmount) {
          throw new InternalServerErrorException(
            `Max allowed claim amount not found for denom: ${this.denom}`,
          );
        }

        const maxAmount = parseInt(maxAllowedClaimAmount, 10);
        const splits = this.calculateSplits(heldAmount, maxAmount);
        this.logger.log(
          `${LOG_TAG} user=${userDid} cost: claiming heldAmount=${heldAmount} ${this.denom} | per-claim ceiling maxAmount=${maxAmount} ${this.denom} (from oracle pricing list) | ${splits.length} claim(s)`,
        );

        const collectionId =
          subscription.claimCollections.oracleClaimsCollectionId;
        const subscriptionForProcessing = {
          adminAddress: subscription.adminAddress,
          claimCollections: {
            oracleClaimsCollectionId: collectionId,
          },
          totalCredits: subscription.totalCredits,
        };

        if (splits.length > 1) {
          this.logger.log(
            `${LOG_TAG} user=${userDid} heldAmount=${heldAmount} exceeds per-claim max ${maxAmount} — splitting into ${splits.length} chunks: ${splits.join(', ')}`,
          );

          for (let i = 0; i < splits.length; i++) {
            const splitAmount = splits[i]!;
            try {
              await this.processAmount(
                userDid,
                splitAmount,
                subscriptionForProcessing,
                {
                  index: i + 1,
                  total: splits.length,
                  originalAmount: heldAmount,
                },
              );
            } catch (error) {
              this.logger.error(
                `Error processing split ${i + 1}/${splits.length} for user ${userDid}:`,
                error instanceof Error ? error.message : String(error),
                error instanceof Error ? error.stack : undefined,
              );
              throw new Error(
                `Failed to process split ${i + 1}/${splits.length}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }

          this.logger.log(
            `${LOG_TAG} DONE user=${userDid} — all ${splits.length} split claim(s) submitted successfully`,
          );
        } else {
          this.logger.log(
            `${LOG_TAG} user=${userDid} heldAmount=${heldAmount} within per-claim max ${maxAmount} — no splitting needed`,
          );

          await this.processAmount(
            userDid,
            heldAmount,
            subscriptionForProcessing,
          );
        }

        submitted++;
      } catch (error) {
        failed++;
        this.logger.error(
          `${LOG_TAG} FAILED user=${userDid} — ${
            error instanceof Error ? error.message : String(error)
          } (held amount + pending claim kept, will retry next tick)`,
          error instanceof Error ? error.stack : undefined,
        );
        // Don't clear held amount or pending claim - will retry next run.
      }
    }

    this.logger.log(
      `${LOG_TAG} Cron tick complete: submitted=${submitted} skipped=${skipped} failed=${failed} (of ${users.length} candidate user(s))`,
    );
  }

  /**
   * Invoke the LangGraph workflow for a single amount (full or split chunk)
   * and reconcile the held-amount / pending-claim records on success.
   */
  private async processAmount(
    userDid: string,
    heldAmount: number,
    subscription: {
      adminAddress: string;
      claimCollections: { oracleClaimsCollectionId: string };
      totalCredits: number;
    },
    splitContext?: SplitContext,
  ): Promise<void> {
    if (heldAmount <= 0) {
      throw new Error(
        `Invalid held amount: ${heldAmount}. Must be greater than 0.`,
      );
    }

    const claimLabel = splitContext
      ? `split ${splitContext.index}/${splitContext.total} (amount=${heldAmount}, original=${splitContext.originalAmount})`
      : `full claim (amount=${heldAmount})`;

    this.logger.log(
      `${LOG_TAG} user=${userDid} — starting 4-step workflow for ${claimLabel}`,
    );

    const internalClaimId = await this.tokenLimiter.getOrCreatePendingClaim(
      userDid,
      heldAmount,
    );

    const workflowParams: ProcessClaimParams = {
      userDid,
      heldAmount,
      subscription,
      internalClaimId,
      denom: this.denom,
      configService: this.configService,
    };

    // Unique thread ID per split so checkpointer state doesn't collide.
    const threadId = splitContext
      ? `${userDid}:${internalClaimId}:split${splitContext.index}`
      : `${userDid}:${internalClaimId}`;
    const config = {
      configurable: {
        thread_id: threadId,
      },
    };

    const workflow = this.getProcessClaimWorkflow();
    const result = await workflow.invoke(workflowParams, config);

    if (result.success && result.cid) {
      await this.tokenLimiter.clearPendingClaim(userDid);

      if (splitContext) {
        await this.tokenLimiter.incrementUserHeldAmount(userDid, -heldAmount);
        this.logger.log(
          `${LOG_TAG} ✔ SUBMITTED user=${userDid} claimCid=${result.cid} — split ${splitContext.index}/${splitContext.total} done, held amount decremented by ${heldAmount}`,
        );
      } else {
        await this.tokenLimiter.deleteUserHeldAmount(userDid);
        this.logger.log(
          `${LOG_TAG} ✔ SUBMITTED user=${userDid} claimCid=${result.cid} — full claim done, held amount + pending claim cleared`,
        );
      }
    } else {
      this.logger.warn(
        `${LOG_TAG} workflow completed but result indicates failure for user=${userDid}${
          splitContext
            ? ` (split ${splitContext.index}/${splitContext.total})`
            : ''
        } — held amount kept, will retry next tick`,
      );
    }
  }
}

/**
 * Submit a saved claim to the subscription-API webhook so the upstream
 * service can mark it credited. Kept inline (rather than a separate file)
 * since it's only used here and trivial.
 */
export async function submitClaimToSubscriptionApi(
  subscriptionApiUrl: string,
  claimId: string,
): Promise<{ approved: boolean; reason?: string }> {
  const webhookUrl = `${subscriptionApiUrl}/api/v1/webhook/claim-submitted`;

  Logger.log(
    'Submitting claim to subscription API',
    'SubmitClaimToSubscriptionApi',
    { webhookUrl, claimId },
  );

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claimId }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    Logger.error(
      `Subscription API error: ${response.status} ${errorBody}`,
      'SubmitClaimToSubscriptionApi',
      { status: response.status, errorBody, claimId },
    );
    throw new Error(`Subscription API error: ${response.status} ${errorBody}`);
  }

  return (await response.json()) as { approved: boolean; reason?: string };
}
