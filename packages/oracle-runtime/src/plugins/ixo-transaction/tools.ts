import { callAgAction } from '@ixo/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import {
  DEFERRED_MODULES,
  MESSAGE_CATALOG,
  QUERY_ONLY_MODULES,
} from './catalog.js';
import { classifyIntent } from './intent.js';
import {
  NetworkSchema,
  RiskConfirmationSchema,
  TestnetReceiptSchema,
} from './schemas.js';
import { validateTransactionDraft } from './validate.js';

/**
 * Name of the AG-UI action the Portal frontend registers to sign with the
 * user's wallet (`transactSignX`). The plugin dispatches validated messages to
 * it and awaits the signed result.
 */
export const SIGN_TRANSACTION_ACTION = 'sign_transaction';

/** Default wallet-signing timeout — human-paced, well above the AG-UI default. */
export const DEFAULT_SIGN_TIMEOUT_MS = 120_000;

/**
 * LLM-facing draft shape. Strict canonicalization (defaults, cross-field rules)
 * happens inside `validateTransactionDraft`; this schema just describes the
 * arguments the agent supplies.
 */
const DraftToolSchema = z.object({
  input: z.string().optional(),
  command: z.string().optional(),
  messageType: z.string().optional(),
  action: z.string().optional(),
  typeUrl: z.string().optional(),
  value: z.record(z.string(), z.unknown()).optional(),
  memo: z.string().optional(),
  network: NetworkSchema.optional(),
  riskConfirmation: RiskConfirmationSchema.optional(),
  testnetReceipt: TestnetReceiptSchema.optional(),
  overrideMainnet: z.boolean().optional(),
  overrideReason: z.string().optional(),
});

const IntentInputToolSchema = z.object({
  input: z.string().min(1),
});

const RouteListToolSchema = z.object({
  messageType: z.string().optional(),
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyFailure(message: string): 'timeout' | 'rejected' | 'error' {
  if (/timeout/i.test(message)) return 'timeout';
  if (/reject|denied|declin|cancel/i.test(message)) return 'rejected';
  return 'error';
}

function summarizeRoutes(messageType?: string): unknown {
  const normalized = messageType?.trim().toLowerCase();
  const routes = MESSAGE_CATALOG.filter(
    (entry) => !normalized || entry.module === normalized,
  ).map((entry) => ({
    command: `/ixo ${entry.module} ${entry.action}`,
    module: entry.module,
    action: entry.action,
    messageName: entry.messageName,
    typeUrl: entry.typeUrl,
    fields: entry.fields,
    riskLevel: entry.riskLevel,
    risks: entry.risks,
  }));

  return {
    slashCommandFormat: '/ixo {message-type} {message-action}',
    queryOnlyModules: QUERY_ONLY_MODULES,
    deferredModules: DEFERRED_MODULES,
    routes,
  };
}

export interface IxoTransactionToolsOptions {
  /** Wallet-signing timeout in ms (read from plugin config). */
  signTimeoutMs?: number;
}

export function createIxoTransactionTools(
  options: IxoTransactionToolsOptions = {},
): PluginTool[] {
  const signTimeoutMs = options.signTimeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;

  return [
    tool(
      async (args) => {
        const { messageType } = RouteListToolSchema.parse(args);
        return summarizeRoutes(messageType);
      },
      {
        name: 'list_ixo_transaction_routes',
        description:
          'List supported IXO transaction routes, their required fields, and risk levels. Read-only; never signs.',
        schema: RouteListToolSchema,
      },
    ),

    tool(
      async (args) => {
        const { input } = IntentInputToolSchema.parse(args);
        return classifyIntent(input);
      },
      {
        name: 'classify_ixo_transaction_intent',
        description:
          'Resolve an IXO transaction intent from a slash command, Msg name, typeUrl, or natural-language prompt. Read-only.',
        schema: IntentInputToolSchema,
      },
    ),

    tool(
      async (args) => {
        const validated = validateTransactionDraft(args);
        return {
          status: 'valid',
          intent: validated.intent,
          message: validated.message,
          risks: validated.risks,
          riskLevel: validated.riskLevel,
          requiresConfirmation: validated.requiresConfirmation,
          network: validated.network,
        };
      },
      {
        name: 'validate_ixo_transaction_draft',
        description:
          'Strictly validate an IXO transaction draft and return the canonical message, risks, and network gate status WITHOUT signing. Use this to collect fields and surface risks before signing.',
        schema: DraftToolSchema,
      },
    ),

    tool(
      async (args, ctx: RuntimeContext) => {
        let validated;
        try {
          validated = validateTransactionDraft(args, {
            requireRiskConfirmation: true,
          });
        } catch (err) {
          return { status: 'validation_error', error: errorMessage(err) };
        }

        const sessionId = ctx.session?.id;
        if (!sessionId) {
          return {
            status: 'unavailable',
            error:
              'Wallet signing is only available in a Portal session (no session id on this request).',
          };
        }

        const requestId = ctx.session.requestId;
        const toolCallId =
          ctx.toolCallId ??
          `tx_${requestId || 'noreq'}_${randomUUID().slice(0, 8)}`;

        const actionArgs = {
          messages: [validated.message],
          memo: validated.memo,
          network: validated.network,
          metadata: {
            messageName: validated.intent.messageName,
            typeUrl: validated.intent.typeUrl,
            riskLevel: validated.riskLevel,
            risks: validated.risks,
          },
        };

        try {
          const result = await callAgAction({
            sessionId,
            toolCallId,
            toolName: SIGN_TRANSACTION_ACTION,
            args: actionArgs,
            timeout: signTimeoutMs,
          });
          return {
            status: 'signed',
            typeUrl: validated.intent.typeUrl,
            network: validated.network,
            result,
          };
        } catch (err) {
          const message = errorMessage(err);
          return {
            status: classifyFailure(message),
            error: message,
            typeUrl: validated.intent.typeUrl,
            network: validated.network,
          };
        }
      },
      {
        name: 'sign_ixo_transaction',
        description:
          "Validate an IXO transaction draft, enforce risk and testnet-first gates, then dispatch it to the user's Portal wallet for signing and return the result. Requires riskConfirmation for risky transactions. The oracle never signs or holds keys.",
        schema: DraftToolSchema,
      },
    ),
  ];
}
