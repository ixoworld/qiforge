import { callAgAction } from '@ixo/common/ai/tools/action-caller';
import {
  tool,
  z,
  type PluginTool,
  type RuntimeContext,
} from '@ixo/oracle-runtime/plugin-api';
import { randomUUID } from 'node:crypto';

import { MESSAGE_CATALOG, QUERY_ONLY_MODULES } from '../catalog.js';
import { classifyIntent } from '../intent.js';
import {
  SIGN_TRANSACTION_ACTION_NAME,
  SignTransactionActionResultSchema,
  buildSignTransactionActionArgs,
  normalizeWalletSignResult,
} from '../action.js';
import { TransactionDraftSchema } from '../schemas.js';
import { validateTransactionDraft } from '../validate.js';

const ACTION_TIMEOUT_MS = 120_000;

const TransactionDraftToolSchema = TransactionDraftSchema;

const IntentInputToolSchema = z
  .object({
    input: z.string().min(1),
  })
  .strict();

const RouteListToolSchema = z
  .object({
    messageType: z.string().optional(),
  })
  .strict();

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
    portalRegistry: entry.portalRegistry,
  }));

  return {
    slashCommandFormat: '/ixo {message-type} {message-action}',
    queryOnlyModules: QUERY_ONLY_MODULES,
    routes,
  };
}

function buildToolCallId(ctx: RuntimeContext): string {
  const requestId = ctx.session.requestId ?? 'noreq';
  return `ixo_tx_${requestId}_${randomUUID().slice(0, 8)}`;
}

async function dispatchSignTransactionAction(
  input: unknown,
  ctx: RuntimeContext,
): Promise<unknown> {
  const actionArgs = buildSignTransactionActionArgs(input);
  const sessionId = ctx.session.id;
  if (!sessionId) {
    throw new Error('sessionId is required to dispatch wallet signing');
  }

  const result = await callAgAction({
    sessionId,
    toolCallId: buildToolCallId(ctx),
    toolName: SIGN_TRANSACTION_ACTION_NAME,
    args: actionArgs,
    timeout: ACTION_TIMEOUT_MS,
  });

  const parsed = SignTransactionActionResultSchema.safeParse(result);
  return parsed.success ? parsed.data : normalizeWalletSignResult(result);
}

export function createIxoTransactionTools(): PluginTool[] {
  return [
    tool(
      async (args: unknown) => {
        const { messageType } = RouteListToolSchema.parse(args);
        return summarizeRoutes(messageType);
      },
      {
        name: 'list_ixo_transaction_routes',
        description:
          'List supported IXO transaction routes, required fields, risk levels, and query-only modules.',
        schema: RouteListToolSchema,
      },
    ),
    tool(
      async (args: unknown) => {
        const { input } = IntentInputToolSchema.parse(args);
        return classifyIntent(input);
      },
      {
        name: 'classify_ixo_transaction_intent',
        description:
          'Resolve an IXO transaction intent from a slash command, Msg name, typeUrl, or natural-language prompt.',
        schema: IntentInputToolSchema,
      },
    ),
    tool(
      async (args: unknown) => {
        const draft = TransactionDraftToolSchema.parse(args);
        return validateTransactionDraft(draft);
      },
      {
        name: 'validate_ixo_transaction_draft',
        description:
          'Strictly validate an IXO transaction draft and return the canonical message, risks, network gate status, and resolved intent.',
        schema: TransactionDraftToolSchema,
      },
    ),
    tool(dispatchSignTransactionAction, {
      name: 'sign_ixo_transaction',
      description:
        'Validate, risk-gate, and dispatch the IXO transaction to the Portal frontend sign_transaction wallet action. Requires the Portal frontend to register the hidden ixo-transaction/react signing action.',
      schema: TransactionDraftToolSchema,
    }),
  ];
}
