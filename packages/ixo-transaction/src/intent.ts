import {
  DEFERRED_MODULES,
  MESSAGE_CATALOG,
  QUERY_ONLY_MODULES,
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
  // Deferred modules: aliased so the refusal names the module.
  bond: 'bonds',
  'liquid-stake': 'liquidstake',
  name: 'names',
};

const ACTION_ALIASES: Record<string, string> = {
  addlinkedresource: 'add-linked-resource',
  'add-resource': 'add-linked-resource',
  'attach-resource': 'add-linked-resource',
  addlinkedentity: 'add-linked-entity',
  'add-entity': 'add-linked-entity',
  createentity: 'create',
  msgcreateentity: 'create',
  megcreateentity: 'create',
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
    pattern: /\b(megcreateentity|msgcreateentity|createentity)\b/i,
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

function includesModule(modules: readonly string[], module: string): boolean {
  return modules.includes(module);
}

/** The route's message, or an error that says why the route is unavailable. */
function requireRoute(module: string, action: string): MessageSpec {
  const spec = findMessageByRoute(module, action);
  if (spec) return spec;
  if (includesModule(DEFERRED_MODULES, module)) {
    throw new Error(
      `The ${module} module is not supported yet: /ixo ${module} ${action} cannot be prepared for signing`,
    );
  }
  if (includesModule(QUERY_ONLY_MODULES, module)) {
    throw new Error(
      `The ${module} module has no user transactions: /ixo ${module} ${action} cannot be signed`,
    );
  }
  throw new Error(
    `Unsupported IXO transaction route: /ixo ${module} ${action}`,
  );
}

/** A Msg typeUrl (`/ixo.token.v1beta1.MsgRetireToken`) rather than a slash command. */
const TYPE_URL = /^\/[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\.Msg[A-Za-z0-9]+$/;
const IXO_TYPE_URL_MODULE = /^\/ixo\.([a-z0-9]+)\./;

/** The typeUrl's message, or an error that names a deferred or query-only module. */
function requireTypeUrl(typeUrl: string): MessageSpec {
  const spec = findMessageByTypeUrl(typeUrl);
  if (spec) return spec;
  const protoModule = IXO_TYPE_URL_MODULE.exec(typeUrl)?.[1];
  const module = protoModule ? normalizeModule(protoModule) : undefined;
  if (module && includesModule(DEFERRED_MODULES, module)) {
    throw new Error(
      `The ${module} module is not supported yet: ${typeUrl} cannot be prepared for signing`,
    );
  }
  if (module && includesModule(QUERY_ONLY_MODULES, module)) {
    throw new Error(
      `The ${module} module has no user transactions: ${typeUrl} cannot be signed`,
    );
  }
  throw new Error(`Unsupported IXO transaction typeUrl: ${typeUrl}`);
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

  const spec = requireRoute(
    normalizeModule(rawModule),
    normalizeAction(rawAction),
  );
  return toIntent(spec, 'slash-command', 1);
}

export function classifyIntent(input: string): IntentResult {
  const trimmed = input.trim();

  // A Msg typeUrl also starts with `/`, so resolve it before the slash command.
  if (TYPE_URL.test(trimmed)) {
    return toIntent(requireTypeUrl(trimmed), 'type-url', 1);
  }

  if (trimmed.startsWith('/')) return parseSlashCommand(trimmed);

  const compact = trimmed.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const messageNameSpec = routeForMessageName(compact);
  if (messageNameSpec)
    return toIntent(messageNameSpec, 'natural-language', 0.95);

  // Every rule that matches, one per route: a request two routes fit
  // ("transfer my credits to the domain account") is ambiguous, not the
  // first rule's.
  const matches = new Map<string, { spec: MessageSpec; confidence: number }>();
  for (const rule of NATURAL_LANGUAGE_RULES) {
    if (!rule.pattern.test(trimmed)) continue;
    const spec = findMessageByRoute(rule.module, rule.action);
    if (!spec) continue;
    const previous = matches.get(spec.typeUrl);
    if (!previous || previous.confidence < rule.confidence) {
      matches.set(spec.typeUrl, { spec, confidence: rule.confidence });
    }
  }
  const [only, ...others] = [...matches.values()];
  if (only && others.length === 0) {
    return toIntent(only.spec, 'natural-language', only.confidence);
  }
  if (only) {
    throw new Error(
      `Ambiguous IXO transaction intent. Candidate routes: ${[only, ...others]
        .map(({ spec }) => `/ixo ${spec.module} ${spec.action}`)
        .join(', ')}`,
    );
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
    const spec = requireRoute(
      normalizeModule(input.messageType),
      normalizeAction(input.action),
    );
    return toIntent(spec, 'explicit-route', 1);
  }
  if (input.typeUrl) {
    return toIntent(requireTypeUrl(input.typeUrl), 'type-url', 1);
  }
  if (input.input) return classifyIntent(input.input);
  throw new Error('No transaction intent was provided');
}
