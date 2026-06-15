import {
  MESSAGE_CATALOG,
  findMessageByRoute,
  findMessageByTypeUrl,
  routeForMessageName,
  type MessageSpec,
} from './catalog.js';

export type IntentResult = {
  source: 'slash-command' | 'natural-language' | 'type-url' | 'explicit-route';
  module: string;
  action: string;
  messageName: string;
  typeUrl: string;
  confidence: number;
  ambiguities: string[];
};

const MODULE_ALIASES: Record<string, string> = {
  entity: 'entity',
  domain: 'entity',
  iid: 'iid',
  did: 'iid',
  claim: 'claims',
  claims: 'claims',
  token: 'token',
  credit: 'token',
  credits: 'token',
  smartaccount: 'smart-account',
  'smart-account': 'smart-account',
  authenticator: 'smart-account',
};

const ACTION_ALIASES: Record<string, string> = {
  addlinkedresource: 'add-linked-resource',
  'add-resource': 'add-linked-resource',
  'attach-resource': 'add-linked-resource',
  addlinkedentity: 'add-linked-entity',
  'add-entity': 'add-linked-entity',
  createentity: 'create',
  msgcreateentity: 'create',
  verify: 'update-verified',
  verified: 'update-verified',
  grant: 'grant-account-authz',
  revoke: 'revoke-account-authz',
  retirecredits: 'retire',
  retirecredit: 'retire',
  addauthenticator: 'add-authenticator',
  removeauthenticator: 'remove-authenticator',
};

const NATURAL_LANGUAGE_RULES: Array<{
  pattern: RegExp;
  module: string;
  action: string;
  confidence: number;
}> = [
  {
    pattern: /\b(msgcreateentity|createentity)\b/i,
    module: 'entity',
    action: 'create',
    confidence: 0.98,
  },
  {
    pattern:
      /\b(create|new|register|set up)\b.*\b(domain|entity|dao|oracle|project|protocol|asset)\b/i,
    module: 'entity',
    action: 'create',
    confidence: 0.92,
  },
  {
    pattern: /\btransfer\b.*\b(entity|domain|ownership)\b/i,
    module: 'entity',
    action: 'transfer',
    confidence: 0.9,
  },
  {
    pattern: /\b(verify|mark verified|unverify)\b.*\b(entity|domain)\b/i,
    module: 'entity',
    action: 'update-verified',
    confidence: 0.86,
  },
  {
    pattern: /\b(add|attach)\b.*\blinked resource\b/i,
    module: 'iid',
    action: 'add-linked-resource',
    confidence: 0.9,
  },
  {
    pattern: /\b(add|attach)\b.*\blinked entity\b/i,
    module: 'iid',
    action: 'add-linked-entity',
    confidence: 0.9,
  },
  {
    pattern: /\bsubmit\b.*\bclaim\b/i,
    module: 'claims',
    action: 'submit',
    confidence: 0.9,
  },
  {
    pattern: /\bevaluate\b.*\bclaim\b/i,
    module: 'claims',
    action: 'evaluate',
    confidence: 0.9,
  },
  {
    pattern: /\bretire\b.*\b(credit|credits|token|tokens)\b/i,
    module: 'token',
    action: 'retire',
    confidence: 0.92,
  },
  {
    pattern: /\bmint\b.*\b(credit|credits|token|tokens)\b/i,
    module: 'token',
    action: 'mint',
    confidence: 0.9,
  },
  {
    pattern: /\btransfer\b.*\b(credit|credits|token|tokens)\b/i,
    module: 'token',
    action: 'transfer',
    confidence: 0.88,
  },
  {
    pattern: /\b(add|create)\b.*\bauthenticator\b/i,
    module: 'smart-account',
    action: 'add-authenticator',
    confidence: 0.9,
  },
];

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function normalizeModule(value: string): string {
  const token = normalizeToken(value);
  return MODULE_ALIASES[token] ?? token;
}

function normalizeAction(value: string): string {
  const token = normalizeToken(value);
  return ACTION_ALIASES[token] ?? token;
}

function toIntent(
  spec: MessageSpec,
  source: IntentResult['source'],
  confidence: number,
  ambiguities: string[] = [],
): IntentResult {
  return {
    source,
    module: spec.module,
    action: spec.action,
    messageName: spec.messageName,
    typeUrl: spec.typeUrl,
    confidence,
    ambiguities,
  };
}

export function parseSlashCommand(input: string): IntentResult {
  const match = input
    .trim()
    .match(/^\/ixo\s+([a-z0-9_-]+)\s+([a-z0-9_-]+)(?:\s+.*)?$/i);
  if (!match) {
    throw new Error(
      'Slash command must use /ixo {message-type} {message-action}',
    );
  }
  const [, rawModule, rawAction] = match;
  if (!rawModule || !rawAction) {
    throw new Error(
      'Slash command must use /ixo {message-type} {message-action}',
    );
  }

  const module = normalizeModule(rawModule);
  const action = normalizeAction(rawAction);
  const spec = findMessageByRoute(module, action);
  if (!spec) {
    throw new Error(
      `Unsupported IXO transaction route: /ixo ${module} ${action}`,
    );
  }
  return toIntent(spec, 'slash-command', 1);
}

export function classifyIntent(input: string): IntentResult {
  const trimmed = input.trim();

  // A Msg typeUrl also starts with `/`, so resolve it before the slash command.
  const typeUrlSpec = findMessageByTypeUrl(trimmed);
  if (typeUrlSpec) return toIntent(typeUrlSpec, 'type-url', 1);

  if (trimmed.startsWith('/')) return parseSlashCommand(trimmed);

  const compact = trimmed.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const messageNameSpec = routeForMessageName(compact);
  if (messageNameSpec)
    return toIntent(messageNameSpec, 'natural-language', 0.95);

  for (const rule of NATURAL_LANGUAGE_RULES) {
    if (rule.pattern.test(trimmed)) {
      const spec = findMessageByRoute(rule.module, rule.action);
      if (spec) return toIntent(spec, 'natural-language', rule.confidence);
    }
  }

  const possible = MESSAGE_CATALOG.filter(
    (entry) =>
      trimmed.toLowerCase().includes(entry.module) ||
      trimmed.toLowerCase().includes(entry.action),
  );
  const ambiguities = possible
    .slice(0, 5)
    .map((entry) => `/ixo ${entry.module} ${entry.action}`);
  throw new Error(
    ambiguities.length > 0
      ? `Ambiguous IXO transaction intent. Candidate routes: ${ambiguities.join(', ')}`
      : 'Unable to identify an IXO transaction type from the prompt',
  );
}

export function resolveIntent(input: {
  input?: string;
  command?: string;
  messageType?: string;
  action?: string;
  typeUrl?: string;
}): IntentResult {
  if (input.command) return parseSlashCommand(input.command);
  if (input.messageType && input.action) {
    const module = normalizeModule(input.messageType);
    const action = normalizeAction(input.action);
    const spec = findMessageByRoute(module, action);
    if (!spec)
      throw new Error(
        `Unsupported IXO transaction route: /ixo ${module} ${action}`,
      );
    return toIntent(spec, 'explicit-route', 1);
  }
  if (input.typeUrl) {
    const spec = findMessageByTypeUrl(input.typeUrl);
    if (!spec)
      throw new Error(`Unsupported IXO transaction typeUrl: ${input.typeUrl}`);
    return toIntent(spec, 'type-url', 1);
  }
  if (input.input) return classifyIntent(input.input);
  throw new Error('No transaction intent was provided');
}
