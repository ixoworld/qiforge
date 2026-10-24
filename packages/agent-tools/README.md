# @ixo/agent-tools

Ten read tools share one typed catalog, strict input validation, and host-bound authorization. The package runs in Workers without Node compatibility. It contains no service clients, credentials, transport handlers, runtime plugins, or money movement.

## Public contract

The package exports six runtime values from its root.

| Export                    | Contract                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `CATALOG_VERSION`         | `2.0.0`                                                                                                     |
| `SOURCE_ENVELOPE_VERSION` | `1`                                                                                                         |
| `catalog`                 | Immutable tool descriptions, generated argument schemas, read effect, permission names, and policy variants |
| `createAgentToolsHost`    | Trusted host factory with context binding, discovery, and invocation                                        |
| `nativeTools`             | Immutable `name`, `description`, `inputSchema`, and `effect` descriptors                                    |
| `mcpTools`                | Immutable `name`, `description`, `inputSchema`, and read-only MCP annotations                               |

Both descriptor functions reuse the catalog's generated input schemas. The schemas require object arguments and reject additional properties. Error explanation accepts exactly one of `errorText` and `errorId`. A provider integration may need to translate JSON Schema features such as `anyOf`. This package does not register tools with an LLM provider or an MCP server.

Public types include `Adapters`, `Adapter`, `AdapterInput`, `ToolInput`, `ToolValue`, `ToolName`, `Available`, `Refusal`, `HostFacts`, `ContextToken`, `VerifiedGrant`, `ResourceReceipt`, and `AgentToolsHost`. Literal tool names infer their corresponding result values. Dynamic names return a checked union. Deep imports are unsupported.

## Host binding

The host supplies verified identity and authority. Model arguments never select a user, oracle, network, room, session, timezone, endpoint, or storage namespace.

```ts
import { createAgentToolsHost, type Adapters } from '@ixo/agent-tools';

const adapters = {
  ixo_credits_get: ({ context }) => ({
    version: 1,
    status: 'available',
    scope: { ...context },
    value: {
      lookupStatus: 'confirmed',
      amount: '123456789012345678901001',
      denomination: 'upay',
      decimals: 3,
      ledger: 'subscription_credits',
      network: context.network,
    },
    evidence: [
      {
        source: 'subscriptions',
        reference: 'fake-ledger-record',
        revision: 'fake-revision',
        observedAt: '2026-10-24T12:00:00Z',
        freshness: 'current',
      },
    ],
  }),
} satisfies Adapters;

const host = createAgentToolsHost({
  adapters,
  now: () => Date.parse('2026-10-24T12:00:00Z'),
  readGrants: (context) => [
    {
      ...context,
      tool: 'ixo_credits_get',
      expiresAt: '2026-10-24T13:00:00Z',
    },
  ],
});
const token = host.bindContext({
  userDid: 'did:ixo:alice',
  oracleDid: 'did:ixo:companion',
  network: 'devnet',
  sessionId: 'session-a',
  roomId: 'room-a',
  visibility: 'private',
  timezone: 'Asia/Singapore',
});
const result = await host.invoke(token, 'ixo_credits_get', {});
if (result.status === 'available') {
  result.value.amount;
}
```

This example uses a fake ledger and fake grants. Production hosts verify authority and retrieve evidence outside this package. `bindContext` validates all seven fields and the IANA timezone, copies the facts, and freezes them. Invalid facts throw `TypeError`. Tokens serialize to `{}` and belong to one host. Forged objects and foreign-host tokens cannot discover or invoke tools.

`readGrants(context)` returns unknown data. Each grant has exactly the seven context fields, `tool`, and `expiresAt`. Unknown properties or malformed grants, including invalid expiry timestamps, make authority unavailable even if another grant is valid. Empty or nonmatching grants produce `grant_missing`. Well-formed matching grants whose expiry has passed produce `grant_expired`. Each decision binds visibility and timezone as well as user, oracle, network, session, and room.

`resourceAccess(context, receipt)` is required for files, owned error records, operations, personal memory, and oracle knowledge. It must return literal `true` for every receipt, including file coverage. The host passes frozen copies containing the tool name and current evidence. The integrating host owns room membership and resource permissions.

Discovery is advisory. Invocation reads grants before retrieval, after retrieval, and after resource checks immediately before disclosure. Revocation observed by any of these checks suppresses the value. There is no grant or response cache. A transport must not reuse answers across authority changes or delay their disclosure indefinitely.

## Adapter source envelope

Adapters return unknown data. Every available response has exactly this structure.

```ts
{
  version: 1,
  status: 'available',
  scope: {
    userDid, oracleDid, network, sessionId, roomId, visibility, timezone,
  },
  value,
  evidence: [{ source, reference, revision, observedAt, freshness }],
}
```

The scope must match all seven bound context fields. The only non-success envelopes are `{ version: 1, status: 'unauthorized' }` and `{ version: 1, status: 'unavailable' }`. Extra diagnostic or credential fields are rejected. Exceptions produce safe refusals without exception text.

Source data must be plain objects, dense arrays, finite numbers, strings, booleans, or null. Accessors, cycles, symbols, functions, unsupported prototypes, and extra schema properties are rejected. Boundary snapshots limit nesting to 32 levels, visits to 100,000 values, object keys to 10,000, and individual strings to 1,000,000 characters. Tool schemas impose smaller field and collection limits.

The host copies and freezes source data before another authority callback can run. Adapter-owned objects remain mutable by their owner. Adapter inputs, host context, resource receipts, and returned values are deeply frozen. Concurrent invocations hold separate snapshots.

Evidence requires one to 100 receipts, allowed sources, exact references and revisions, and current timestamps. Timestamps use ISO 8601 with `Z` or an explicit offset and a valid calendar date. Future, historical, unknown, or stale evidence fails closed. Canonical documents have a maximum age of one day. Other tools have five minutes. Grant expiry, freshness and quote expiry are checked again after the final grant read, with no further await before return. When several matching grants exist, the latest expiry determines whether authority remains current.

## Tool values

| Tool                         | Value and authority requirements                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ixo_account_get`            | Verified root DID IXO account address and selected network                                                                                          |
| `ixo_credits_get`            | Confirmed subscription lookup, exact nonnegative decimal string, `upay`, three decimals, ledger, and selected network                               |
| `ixo_concept_get`            | Canonical versioned text, permitted in shared contexts                                                                                              |
| `ixo_error_explain`          | Supplied-text catalog guidance or a private owned error record, with matching selector and branch-specific evidence                                 |
| `ixo_files_find`             | File matches and source coverage receipts; absence derived by the host                                                                              |
| `ixo_offramp_options`        | USDC eligibility and corridor guidance                                                                                                              |
| `ixo_offramp_quote`          | Reviewed adapter, exact requested asset, amount string and corridor, sourced payout amount, currency, rate, fee, live expiry, and quote-ID evidence |
| `ixo_operation_get`          | Matching owned operation ID and status                                                                                                              |
| `ixo_memory_personal_search` | Private personal facts with exact citations                                                                                                         |
| `ixo_memory_oracle_search`   | Oracle knowledge with exact citations; private knowledge cannot enter shared contexts                                                               |

Credits require `lookupStatus: 'confirmed'` in the adapter value. The host removes that field from the result. Numeric amounts, ambiguous zero, or alternate wallet balances cannot substitute for credit evidence.

File adapters may omit `absenceConfirmed` or supply a boolean. The host ignores that boolean. Absence is true only when no files match and both VFS and attachment coverage are complete. Partial, unindexed, and unavailable coverage cannot establish absence. Unindexed files remain matches. A `when: 'yesterday'` model argument becomes `{ calendarDate, timezone }` from the bound timezone and host clock.

Quotes bind review and implementation in one adapter descriptor.

```ts
const adapters = {
  ixo_offramp_quote: { reviewed: true, invoke: reviewedQuoteReader },
};
```

The factory copies the descriptor's review assertion and function. Later caller mutation cannot swap the function under an earlier assertion. `reviewed: true` is an assertion by the trusted integration, not proof of an external review. A quote never authorizes execution or transfers funds.

## Migration from the frozen reference

The reference remains `0.2.0-proposed`. This package starts at version `0.1.0`, catalog version `2.0.0`, and source-envelope version `1`. These versions identify different contracts.

- `createReferenceHost` becomes `createAgentToolsHost`.
- Every source envelope requires `version: 1`. Legacy envelopes are rejected.
- Grants and available response scope require all seven host fields. Visibility and timezone no longer disappear at the boundary.
- Source envelopes, source values, grants, and arguments reject unknown properties and non-data objects.
- Quote adapters use `{ reviewed: true, invoke }`. The separate `reviewedQuoteAdapter` option is removed.
- File `absenceConfirmed` accepts an optional boolean only. The host always derives its returned value.
- Timestamps reject timezone-less, locale-specific, and invalid-calendar strings that permissive `Date.parse` accepted.
- Native and MCP schemas are generated by Zod. Exclusive error object branches use `anyOf` under a root object schema.
- Responses are owned before post-retrieval awaits. Results are deeply frozen. Final freshness and quote expiry checks prevent disclosure after expiration during an authorization check.

Existing refusal reasons and retryability remain the baseline. Invalid versioned envelopes use `invalid_source_response`. Malformed grant snapshots use `authorization_unavailable`.

## Local verification

The repository Node version is pinned in `.nvmrc`. The package checks run from the repository root.

```sh
pnpm --filter @ixo/agent-tools build
pnpm --filter @ixo/agent-tools typecheck
pnpm --filter @ixo/agent-tools test
pnpm --filter @ixo/agent-tools test:package
```

Behavioral tests use fake adapters and authority callbacks. The 37 migrated reference scenarios retain the original read semantics while explicitly updating source versions, seven-field binding, and the quote descriptor. Additional scenarios cover response ownership, callback mutation, revocation, final expiry, concurrency, invalid source data, and type inference. The package test imports the packed artifact in real workerd without `nodejs_compat`. These checks do not establish live-service integration or model acceptance.

Catalog 2.0.0 requires integer `upay` base units and an explicit file `timeBasis`. Convert `amount` with `decimals: 3` only for display. File timestamps identify VFS registration or session receipt, not original media upload. Source-envelope version stays 1.
