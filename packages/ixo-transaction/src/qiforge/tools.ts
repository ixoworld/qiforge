import { tool, z, type PluginTool } from '@ixo/oracle-runtime';

import { MESSAGE_CATALOG, QUERY_ONLY_MODULES } from '../catalog.js';
import { renderIframeEvent } from '../iframe.js';
import { classifyIntent } from '../intent.js';
import { renderSigningPayload } from '../render.js';
import { validateTransactionDraft } from '../validate.js';

const JsonRecordSchema = z.record(z.string(), z.unknown());

const RiskConfirmationToolSchema = z
  .object({
    confirmed: z.literal(true),
    acceptedRisks: z.array(z.string().min(1)).min(1),
  })
  .strict();

const TestnetReceiptToolSchema = z
  .object({
    network: z.literal('testnet'),
    transactionHash: z.string().min(32).max(128),
    code: z.literal(0),
    height: z.union([z.string(), z.number().int().nonnegative()]).optional(),
  })
  .strict();

const TransactionDraftToolSchema = z
  .object({
    input: z.string().optional(),
    command: z.string().optional(),
    messageType: z.string().optional(),
    action: z.string().optional(),
    typeUrl: z.string().optional(),
    value: JsonRecordSchema.default({}),
    memo: z.string().optional(),
    network: z.enum(['devnet', 'testnet', 'mainnet']).default('testnet'),
    riskConfirmation: RiskConfirmationToolSchema.optional(),
    testnetReceipt: TestnetReceiptToolSchema.optional(),
    overrideMainnet: z.boolean().optional(),
    overrideReason: z.string().min(1).optional(),
  })
  .strict();

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

const RenderToolSchema = TransactionDraftToolSchema.extend({
  iframe: z.boolean().default(false),
}).strict();

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
    tool(
      async (args: unknown) => {
        const { iframe, ...draft } = RenderToolSchema.parse(args);
        if (iframe) {
          return {
            transport: 'ixo.portal.iframe.v1',
            event: renderIframeEvent(draft),
          };
        }
        return {
          transport: 'portal.signxTransaction',
          payload: renderSigningPayload(draft),
        };
      },
      {
        name: 'render_ixo_transaction_payload',
        description:
          'Render the validated Portal signxTransaction payload for signing, or an optional IXO Portal iframe EVENT wrapper when iframe is true.',
        schema: RenderToolSchema,
      },
    ),
  ];
}
