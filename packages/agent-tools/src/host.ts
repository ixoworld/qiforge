import { z } from 'zod';
import {
  bindTools,
  definitions,
  type Adapters,
  type Available,
  type BoundAdapters,
  type Policy,
  type ToolName,
} from './catalog.js';
import {
  envelopeSchema,
  evidenceSchema,
  freeze,
  hostFactsSchema,
  invalid,
  sameScope,
  copyBoundedPlainData,
  timestampSchema,
  validTimestamp,
  unauthorized,
  unavailable,
  type Evidence,
  type HostFacts,
  type Refusal,
} from './schema.js';

const toolNameSchema = z.enum(definitions.map((definition) => definition.name));
const grantSchema = hostFactsSchema.extend({
  tool: toolNameSchema,
  expiresAt: timestampSchema,
});
export type VerifiedGrant = Readonly<z.output<typeof grantSchema>>;
export type ResourceReceipt = Omit<Evidence, 'freshness'> &
  Readonly<{ tool: ToolName; freshness: 'current' }>;
export type HostOptions = Readonly<{
  adapters?: Adapters;
  readGrants?: (context: HostFacts) => unknown | Promise<unknown>;
  resourceAccess?: (
    context: HostFacts,
    receipt: ResourceReceipt,
  ) => unknown | Promise<unknown>;
  now?: () => number;
}>;
const contextBrand = Symbol('AgentToolsContext');
export type ContextToken = Readonly<{ [contextBrand]: true }>;
export type Discovery =
  | Readonly<{ status: 'available'; tools: readonly ToolName[] }>
  | Refusal;
type Authorization =
  | Readonly<{ status: 'authorized'; expiresAt: number }>
  | Refusal;
export interface AgentToolsHost {
  bindContext(facts: unknown): ContextToken;
  discover(token: ContextToken): Promise<Discovery>;
  invoke<N extends ToolName>(
    token: ContextToken,
    name: N,
    args: unknown,
  ): Promise<Available<N> | Refusal>;
  invoke(
    token: ContextToken,
    name: unknown,
    args: unknown,
  ): Promise<Available<ToolName> | Refusal>;
}

function opaqueToken(): ContextToken {
  return Object.freeze({ [contextBrand]: true });
}

function evidenceTime(
  evidence: readonly Evidence[],
  policy: Policy,
  at: number,
): Refusal | null {
  return evidence.some(
    (item) =>
      item.freshness !== 'current' ||
      Date.parse(item.observedAt) > at ||
      at - Date.parse(item.observedAt) > policy.maxAgeMs,
  )
    ? unavailable('evidence_stale')
    : null;
}

export function createAgentToolsHost({
  adapters = {},
  readGrants = async () => [],
  resourceAccess,
  now = Date.now,
}: HostOptions = {}): AgentToolsHost {
  const contexts = new WeakMap<object, HostFacts>();
  const { ixo_offramp_quote: quote, ...ordinaryAdapters } = adapters;
  const quoteBinding =
    quote && Object.freeze({ reviewed: quote.reviewed, invoke: quote.invoke });
  const bound: BoundAdapters = Object.freeze({
    ...ordinaryAdapters,
    ixo_offramp_quote:
      quoteBinding?.reviewed === true &&
      typeof quoteBinding.invoke === 'function'
        ? quoteBinding.invoke
        : undefined,
  });
  const tools = bindTools(bound);

  function bindContext(facts: unknown): ContextToken {
    try {
      const context = freeze(
        hostFactsSchema.parse(copyBoundedPlainData(facts)),
      );
      new Intl.DateTimeFormat('en', { timeZone: context.timezone });
      const token = opaqueToken();
      contexts.set(token, context);
      return token;
    } catch {
      throw new TypeError('Invalid trusted host context');
    }
  }
  async function permission(
    context: HostFacts,
    name: ToolName,
    policy: Policy,
  ): Promise<Authorization> {
    if (policy.disclosure === 'private' && context.visibility !== 'private')
      return unauthorized('disclosure_denied');
    try {
      const grants = freeze(
        z
          .array(grantSchema)
          .max(10000)
          .parse(copyBoundedPlainData(await readGrants(context))),
      );
      const matching = grants.filter(
        (grant) => grant.tool === name && sameScope(grant, context),
      );
      if (!matching.length) return unauthorized('grant_missing');
      const at = now();
      const expiresAt = matching.reduce(
        (latest, grant) => Math.max(latest, Date.parse(grant.expiresAt)),
        -Infinity,
      );
      if (expiresAt <= at) return unauthorized('grant_expired');
      return Object.freeze({ status: 'authorized', expiresAt });
    } catch {
      return unavailable('authorization_unavailable');
    }
  }
  function integration(
    tool: (typeof tools)[number],
    policy: Policy,
  ): Refusal | null {
    if (tool.name === 'ixo_offramp_quote' && !quoteBinding?.reviewed)
      return unavailable('restricted_adapter_required');
    if (!tool.integrated) return unavailable('not_integrated');
    if (policy.resourceCheck && typeof resourceAccess !== 'function')
      return unavailable('resource_check_not_integrated');
    return null;
  }
  async function discover(token: ContextToken): Promise<Discovery> {
    const context = contexts.get(token);
    if (!context) return unauthorized('invalid_context');
    const names: ToolName[] = [];
    for (const tool of tools) {
      for (const policy of tool.policies) {
        if (
          !integration(tool, policy) &&
          (await permission(context, tool.name, policy)).status === 'authorized'
        ) {
          names.push(tool.name);
          break;
        }
      }
    }
    return freeze({ status: 'available', tools: names });
  }

  async function invoke<N extends ToolName>(
    token: ContextToken,
    name: N,
    args: unknown,
  ): Promise<Available<N> | Refusal>;
  async function invoke(
    token: ContextToken,
    name: unknown,
    args: unknown,
  ): Promise<Available<ToolName> | Refusal>;
  async function invoke(
    token: ContextToken,
    name: unknown,
    args: unknown,
  ): Promise<Available<ToolName> | Refusal> {
    const context = contexts.get(token);
    if (!context) return unauthorized('invalid_context');
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) return invalid('unknown_tool');
    let copiedArgs;
    try {
      copiedArgs = copyBoundedPlainData(args);
    } catch {
      return invalid('invalid_arguments');
    }
    const prepared = tool.prepare(copiedArgs, context, now);
    if (prepared.status !== 'prepared') return prepared;
    const authorization = await permission(context, tool.name, prepared.policy);
    if (authorization.status !== 'authorized') return authorization;
    const absent = integration(tool, prepared.policy);
    if (absent) return absent;

    let captured;
    try {
      const raw = await prepared.retrieve();
      try {
        const owned: unknown = copyBoundedPlainData(raw);
        captured = envelopeSchema.safeParse(freeze(owned));
      } catch {
        captured = null;
      }
    } catch {
      return unavailable('upstream_failed');
    }
    const revoked = await permission(context, tool.name, prepared.policy);
    if (revoked.status !== 'authorized') return revoked;
    if (!captured?.success) return unavailable('invalid_source_response');
    const source = captured.data;
    if (source.status === 'unauthorized') return unauthorized('source_denied');
    if (source.status === 'unavailable')
      return unavailable('source_unavailable');
    if (!sameScope(source.scope, context)) return unauthorized('scope_denied');

    const parsedEvidence = z
      .array(evidenceSchema)
      .min(1)
      .max(100)
      .safeParse(source.evidence);
    const evidence = parsedEvidence.success ? freeze(parsedEvidence.data) : [];
    const claim = prepared.parseValue(source.value, evidence);
    if (claim.status !== 'validated') return claim;
    if (
      !Array.isArray(source.evidence) ||
      source.evidence.length === 0 ||
      source.evidence.length > 100
    )
      return unavailable('evidence_missing');
    if (
      !parsedEvidence.success ||
      evidence.some(
        (item) =>
          !prepared.policy.sources.some((allowed) => item.source === allowed) ||
          !validTimestamp(item.observedAt),
      )
    )
      return unavailable('invalid_evidence');
    const at = now();
    const timeFailure =
      claim.checkTime(at) ?? evidenceTime(evidence, prepared.policy, at);
    if (timeFailure) return timeFailure;
    if (prepared.policy.resourceCheck && resourceAccess) {
      for (const item of evidence) {
        try {
          if (
            (await resourceAccess(
              context,
              freeze({ tool: tool.name, ...item, freshness: 'current' }),
            )) !== true
          )
            return unauthorized('resource_denied');
        } catch {
          return unavailable('resource_check_failed');
        }
      }
    }
    const finalAuthorization = await permission(
      context,
      tool.name,
      prepared.policy,
    );
    if (finalAuthorization.status !== 'authorized') return finalAuthorization;
    const finalAt = now();
    if (finalAuthorization.expiresAt <= finalAt)
      return unauthorized('grant_expired');
    const expired =
      claim.checkTime(finalAt) ??
      evidenceTime(evidence, prepared.policy, finalAt);
    if (expired) return expired;
    return claim.answer();
  }
  return Object.freeze({ bindContext, discover, invoke });
}
