# Usage metering and turn gating (for plugin authors)

Four plugin hooks let a plugin meter what a person's use of the oracle costs
and refuse turns it will not pay for (a credits plugin, a quota, a
suspension):

| Hook                      | When                                                                      | What it gets                                                  |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `gateTurn(ctx)`           | before every turn starts, on every entry                                  | `TurnGateContext`: who, which entry, `ctx.kv`, `ctx.ucan`     |
| `onModelCall(call, ctx)`  | after every model call the runtime makes for the person, once per call    | `ModelCallReport`: purpose, payer, tokens, provider cost, ids |
| `onTurnUsage(usage, ctx)` | once per turn attempt, after each of its calls went through `onModelCall` | `TurnModelUsage`: the attempt's calls and totals              |
| `onWake(ctx)`             | when a wake the plugin asked for (`ctx.requestWake(at)`) comes due        | `RuntimeContext` of the person, no run                        |

The types are exported from `@ixo/oracle-runtime-workers`. Source:
`src/plugin-api/turn-gate.ts`, `src/llm/model-call.ts`,
`src/core/turn-gate.ts`, `src/core/model-call-reporter.ts`,
`src/llm/platform-models-policy.ts`.

## A minimal metering and gating plugin

```ts
import {
  OraclePlugin,
  type ModelCallReport,
  type PluginManifest,
  type RuntimeContext,
  type TurnGateContext,
  type TurnGateResult,
  type TurnModelUsage,
} from '@ixo/oracle-runtime-workers';

const NS = 'meter';

export class MeterPlugin extends OraclePlugin {
  readonly name = 'meter';
  readonly version = '1.0.0';
  readonly manifest: PluginManifest = {
    title: 'Meter',
    summary: 'Meters model usage and refuses turns over budget.',
    whenToUse: [],
    visibility: 'silent',
    stability: 'stable',
    category: 'core',
  };
  // A failing gate refuses (503 turn_gate_unavailable) instead of letting
  // unpaid turns through; 300 ms is plenty for one kv read.
  override readonly turnGate = { onFailure: 'closed' as const, timeoutMs: 300 };

  override async gateTurn(ctx: TurnGateContext): Promise<TurnGateResult> {
    // `ctx.kv` idle TTLs slide on every read: keep an absolute expiry
    // (epoch ms) as the value.
    const until = await ctx.kv?.get(NS, 'blockedUntil');
    if (typeof until === 'number' && until > Date.now())
      return {
        refuse: {
          status: 402,
          code: 'credits_exhausted',
          // Plain text, complete on its own, no URL: every surface shows it.
          message: 'You are out of credits. Top up to continue.',
          // The link goes in `action` (https, label at most 40 characters).
          details: {
            action: { label: 'Top up', url: 'https://example.org/top-up' },
          },
        },
      };
    return { allow: true };
  }

  override async onModelCall(call: ModelCallReport): Promise<void> {
    // Per-call metering, e.g. to an analytics sink. `call.callId` is unique.
  }

  override async onTurnUsage(
    usage: TurnModelUsage,
    ctx: RuntimeContext,
  ): Promise<void> {
    const charged = usage.calls.filter((c) => c.paidBy === 'platform');
    if (charged.length === 0) return;
    // One event per attempt: the call ids make it idempotent.
    const event = {
      id: `${usage.runId}:${charged.map((c) => c.callId).join(',')}`,
      usd: usage.platformCostUsd,
      unpriced: usage.unpricedPlatformCalls,
    };
    // Off the reply's path already; `ctx.background` keeps a retry alive.
    await ctx.kv?.update(NS, 'pending', (queue) => [
      ...(Array.isArray(queue) ? queue : []),
      event,
    ]);
  }
}
```

A real billing plugin sends the queued event to its engine (the oracle's own
UCAN from `ctx.ucan.mintSelfSignedInvocation`, the person's delegation as
`ctx.user.ucanDelegation.raw`), and on a refusal from the engine writes the
`blockedUntil` row the gate reads.

## `gateTurn`: where a turn is gated and what a refusal does

The gate runs after authentication and before anything of the turn exists:
no run is recorded, no message stored or mirrored to the oracle room, no
Matrix ledger entry, no file read, no model called, no lock held, no stream
opened. A refused turn therefore leaves nothing to clean up.

| Entry (`ctx.trigger`)                                                  | Gated in                                                                                  | A refusal is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portal`: `POST /turn/:sessionId`, streamed (SSE) or not               | `UserOracleDO.fetch`, before the room mirror and `runs.begin`                             | the HTTP answer: the refusal's status (e.g. `402`) and `{ statusCode, message, code?, details?, requestId, refused: true }` (`TurnRefusalBody`; the marker below), header `x-request-id`, and `Retry-After` when `details.retryAfterSeconds` is set. No SSE stream is opened.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `matrix` (direct room or thread), `matrix-group` (group room)          | `UserOracleDO.runTurn`, before the Matrix turn ledger records the event                   | `TurnResult.refused`; the gateway posts one `m.notice` in the thread (below; transaction id `<reply txn>-refused`, deduplicated), at most one per (room, person, `code`) in 10 minutes, and drops the inbox row. A gateway replay of the same event asks the gate again.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `task`: a scheduled task run, a Topic deliverable run, an approved run | `UserOracleDO.runTurn`, called by the scheduler                                           | the run is **skipped**: its ledger row is `failed` with detail `refused before it started (<status> <code>): <message>`, the task's `lastResult` is `{ ok: false, summary: "Skipped: <message>" }`, the schedule moves to its next occurrence with no backoff and no failure counted. A task the refusal ends (a one-shot, a schedule with no next occurrence) gets one notice in its room, `🛑 **<title>** could not run: <message>`, with `details.action` as a `<label>: <url>` line and a link in its formatted body (transaction id `task-<run id>-refused`; not for a Topic deliverable, whose owner reads the stored result); a recurring task that moves on posts nothing. |
| `channel`, `channel-notice`, `channel-event` (IXO Channels gateway)    | `ChannelTurns.prepare`, after the delegation check, before the session marker and routing | a channel refusal `{ code: "turn_refused", reason?, message, retryAfterSeconds?, action? }` with the refusal's status (402, 403, 429 or 503); `reason` is the plugin's `code`. No receipt, run or session marker is left; the same request id is gated again when resent. The gateway sends `message` (and `action` as a link) to the person (`docs/channels.md`).                                                                                                                                                                                                                                                                                                                 |

`refused: true` in a Portal answer marks a turn refused by a plugin's gate,
whatever its status and `code`: it is never an authentication failure. A
client must not renew credentials (or ask the person for their PIN) on a
`403` that carries it, and shows `message` instead; `@ixo/oracles-client-sdk`
surfaces such an answer at once, without renewing. Only a gate refusal carries
the marker, so a client needs no list of plugin codes. The channel refusal
keeps its own shape (`code: "turn_refused"` is its marker).

Not gated (they are not new turns): a poll of an existing channel request,
re-joining a run (`GET /runs/:id`), a queued run starting later (it was gated
when it was submitted), a run resumed after a reset, the empty-reply retry
inside a channel turn.

Composition and failure:

- Every plugin with `gateTurn` is asked, **concurrently**; the answer is the
  first refusal **in plugin order**, whatever finishes first. Once it is known
  the later gates' `ctx.signal` is aborted. A gate must not assume earlier
  gates allowed the turn. Without a refusal the most restrictive allowance
  wins: one gate answering `{ allow: true, platformModels: 'deny' }`
  restricts the turn to the person's own provider (next section).
- `turnGate.timeoutMs` (default 1,000 ms, at most 10,000 ms) bounds each gate;
  `ctx.signal` aborts at the limit.
- A gate that throws, times out or answers something invalid is a failure:
  `turnGate.onFailure` `open` (default) lets the turn run, `closed` refuses it
  with `503 turn_gate_unavailable`. A refusal is valid with an integer
  `status` 400–599, a `message` of 1–2,000 characters, an optional `code`
  matching `[a-z][a-z0-9_]{0,63}` and optional JSON `details` up to 4 KiB.
  Two `details` fields are understood on every surface:
  `retryAfterSeconds` (a number from 1 to 86,400, rounded up) and
  `action: { label, url }` (`url` https, `label` 1 to 40 characters, trimmed;
  the URL is kept as parsed). An invalid one is removed from the refusal,
  which still stands, and logged
  (`[turn-gate] {"plugin","trigger","requestId","dropped"}`); other `details`
  keys reach the Portal only.
  It is answered with its status when that is `402` (payment needed), `403`
  (not allowed), `429` (too many) or `503` (try again shortly); any other
  status is answered as `403` and logged
  (`[turn-gate] {"plugin","trigger","requestId","status","answeredAs":403}`).
  An `allow` whose `platformModels` is neither `allow` nor `deny` is invalid.
- Logs: one `[turn-gate] refused {"plugin","trigger","requestId","status","code","ms"}`
  line per refusal, one `[turn-gate] {"plugin","trigger","requestId","failure","policy"}`
  warning per failed gate. No user id is logged.
- With no plugin defining `gateTurn` nothing is built and nothing runs.
- Cost: nothing on the path makes a network call unless the plugin does
  (`ctx.hasByoCredentials()` reads the room secrets index through a 60 s
  cache; `ctx.ucan` mints).

### The Matrix room notice

A refused room message is answered by the gateway (`MatrixGatewayDO`,
`src/matrix/refusal-notice.ts`) with one `m.notice` in the message's thread:

- `body`: `message`, then `<label>: <url>` on its own line when the refusal
  has an `action`; `format: org.matrix.custom.html` and `formatted_body`:
  the message HTML-escaped (newlines as `<br>`), then `<br><a href="<url>"><label></a>`.
- Group rooms (the group-chat gate's `roomKind: 'group'`): prefixed with the
  refused person, `<display name>: ` in `body`, a matrix.to pill
  (`<a href="https://matrix.to/#/<percent-encoded user id>">name</a>: `) in
  `formatted_body`, and `m.mentions.user_ids: [<user id>]`. The display name
  is the one the gate read for the turn; without one, the user id's localpart.
  Direct rooms (and `MATRIX_GROUP_ROOMS=answer`, which answers every room as
  direct) have no prefix and an empty `m.mentions`.
- Throttle: at most one notice per (room, person, `code`) in 10 minutes. A
  refused message inside the window posts nothing; its inbox row is dropped
  all the same. A turn that is allowed for that person in that room clears
  their entries there. The entries live in the gateway's SQLite
  (`refusal_notice_throttle`, key room + user + code, the post time): they
  survive a reset; every new entry first sweeps those older than the window,
  so the table holds the last window's notices only. The table is created at
  the first refusal; a gateway that never posted one has none and an allowed
  turn costs one `sqlite_master` read per instance.
- A notice whose send fails gives its claim back (the next refused message
  may post it) and the turn ends with the usual "turn failed" notice.

### Allowing a turn on the person's own provider only

`{ allow: true, platformModels: 'deny' }` lets the turn run, but nothing of it
may run on the platform's model key (the oracle's OpenRouter / Nebius key and
its Decision provider): for a person who may use their own provider (bring
your own LLM) but not the platform's (out of credits). The restriction is
stored with the run (`TurnRequest.platformModels`), so a queued or resumed
attempt keeps it. What happens per role:

| Role / step                                                          | Under `platformModels: 'deny'`                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the turn as a whole                                                  | runs only when it would run on the person's provider; a turn that would not (none connected, the request names a platform model, the credential could not be read) fails before any model is called (`PlatformModelsDeniedError`) |
| `main`, `summarizer`, sub-agents, plugin `ctx.llm`, the safety model | on the person's provider when it serves the role; a role it does not serve (vision on DeepSeek, …) gets a model whose every call fails with `PlatformModelsDeniedError` (building it, binding tools, succeeds)                    |
| a BYO model the provider refuses ("model unavailable")               | **no** platform fallback: the provider's error ends the call (reported `paidBy: 'user'`)                                                                                                                                          |
| session title                                                        | not generated (the session stays untitled; a later unrestricted turn titles it)                                                                                                                                                   |
| attachments, `view_attachment`, memory document ingest               | plain-text files are still read locally; nothing is sent to the extraction model: each such file fails with a clear message the model sees in its place ("Reading this file needs the oracle's own models …")                     |
| capability router                                                    | no Decision: it preloads nothing (as with the Decision provider unavailable); the model loads capabilities with `load_capability`                                                                                                 |
| channel conversation routing                                         | no Decision: the message stays in the current conversation (reason `platform-models-denied`)                                                                                                                                      |
| `ctx.decisions` (plugins), an event turn's `handleChannelEvent`      | rejects with `DecisionProviderUnavailableError`; an event turn's plugin `ctx.llm` is denied                                                                                                                                       |
| a host `getRoomTitle` hook                                           | its model is the turn's: denied unless the person's provider serves its role                                                                                                                                                      |
| group-room summary                                                   | not a turn: not affected                                                                                                                                                                                                          |

Not covered: a model a plugin builds itself without `ctx.llm` (the runtime
cannot see it).

`gateTurn` versus `getRequestAdmission`: admission can **answer** a turn with
a stored direct read, sees a redacted config, and is skipped on group rooms,
task runs and turns with files. The gate can only **refuse**, sees the full
config, and runs on every entry. Admission's contract is unchanged.

## `onModelCall`: every model call, one path

Every model call the runtime makes on a person's behalf ends in one
`ModelCallReport`, delivered once to each plugin's `onModelCall` in the
background (a hook that throws is logged and ignored):

| Field                                                                                 | Meaning                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purpose`                                                                             | what the call was for (table below)                                                                                                                                                                                                               |
| `paidBy`                                                                              | `platform` (the oracle's key) or `user` (the person's own BYO provider: do not charge)                                                                                                                                                            |
| `callId`                                                                              | unique per call attempt, the idempotency key (the LangChain run id of the call, or a UUID)                                                                                                                                                        |
| `startedAt`, `durationMs`                                                             | epoch ms start, duration                                                                                                                                                                                                                          |
| `role`, `requestedModel`, `servedModel`, `provider`, `generationId`                   | as before; `servedModel`/`provider` as the provider reported them                                                                                                                                                                                 |
| `promptTokens`, `cachedTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens` | as reported                                                                                                                                                                                                                                       |
| `costUsd`                                                                             | **provider-reported only** (OpenRouter returns `usage.cost` on every response). The runtime never computes a price: absent for Nebius, BYO, Decisions and calls that failed before usage arrived. Price those yourself (`fetchOpenRouterPrices`). |
| `fallback`, `modelFallback`, `providerFallback`                                       | an OpenRouter model or provider fallback answered                                                                                                                                                                                                 |
| `ok`, `finishReason`, `errorKind`, `errorStatus`, `errorCode`                         | outcome                                                                                                                                                                                                                                           |

`ctx` is the turn's (`ctx.session.requestId`, `ctx.session.runId`,
`ctx.user.did`, `ctx.user.ucanDelegation`, `ctx.kv`, `ctx.background`).
Outside a turn (group summary, channel routing before a run) `ctx.user` is the
person the object serves and `ctx.session.requestId` is the channel request's
id, or a UUID of the call's own.

| Purpose         | Call site                                                                                                                                                                                              | Inside a turn                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `reply`         | the main agent's model (`role` `main`), task runs, the empty-reply retry                                                                                                                               | yes                                             |
| `summarization` | history compaction (`summarizer`)                                                                                                                                                                      | yes                                             |
| `subagent`      | a plugin sub-agent's model (`src/core/sub-agent-fallback.ts`)                                                                                                                                          | yes                                             |
| `plugin`        | a plugin's `ctx.llm` call in a tool, middleware, request hook or `handleChannelEvent`                                                                                                                  | yes                                             |
| `attachment`    | reading a file into text: the turn's attachments, `view_attachment`, memory document ingest (`src/attachments/extract.ts`); one report per HTTP request, a request retried without `max_tokens` is two | yes                                             |
| `title`         | the session title written after the turn (also in that turn's `onTurnUsage`)                                                                                                                           | yes (after it)                                  |
| `routing`       | the capability router's Decision; channel conversation routing                                                                                                                                         | router yes; channel routing no (before the run) |
| `decision`      | a plugin's `ctx.decisions` evaluation                                                                                                                                                                  | yes                                             |
| `safety`        | the host's `safetyModel` hook model                                                                                                                                                                    | yes                                             |
| `group-summary` | a Matrix group room's channel-memory summary (in the latest speaker's object)                                                                                                                          | no                                              |
| `other`         | a model the runtime handed out without a known use (a host `getRoomTitle` hook's model)                                                                                                                | yes                                             |

Not reported (stated so nothing is silently unmetered): a model a plugin
builds itself without `ctx.llm`; a call made inside `onModelCall` or
`channelFailureReply` (they must not call a model; reporting them could loop);
the Yoma plugin's Clef judge (a host-supplied Workers AI runner, billed to the
operator's Cloudflare account); the OpenAI client's own HTTP retries inside
one call (`maxRetries: 2`: one report, the final attempt's usage); the
refused attempt of a BYO model the platform then answered (one report, the
platform's); a streamed call whose consumer stops reading without an error
(LangChain reports no end for it). There are no embedding calls in the
runtime.

Streaming, aborts and errors: a streamed call is reported once when it ends.
An aborted or failed call is reported once with `ok: false`; its tokens and
cost are the provider's only if its usage had arrived (OpenRouter sends it on
the last chunk). A **platform** streamed call that failed or was aborted after
output started, before that usage arrived, carries an **estimate** instead:
`usageEstimated: true`, `promptTokens` = chars/4 of the request's messages
(`estimateContentTokens`, images at their fixed size; tool schemas not
counted), `outputTokens` = chars/4 of the text and tool-call arguments it
streamed, no `costUsd` (price it from the model's list price). An abort
usually ends a call without any end from LangChain (`Runnable.stream` races
the signal outside the model and abandons the stream): the platform model
listens to its signal and hands its record to the call's reporter itself, so
the call is still reported once. A stream that failed before any output
carries no tokens. OpenRouter's `GET /generation` has the billed amount of a
call by `generationId`; the runtime does not call it (a network call per
cut-off call on the hot path; a possible later improvement). Calls made
concurrently in one turn are each reported once, with their own `callId`.

Bring your own LLM: a call the person's provider answered carries
`paidBy: 'user'` and the provider's token counts (no cost). When the person's
provider refuses the model and the platform answers, the call carries the
platform model's record, `paidBy: 'platform'`. Roles a BYO provider does not
serve (embeddings, DeepSeek vision), attachment extraction, titles, group
summaries and Decisions always run on the platform key and say so (unless a
gate restricted the turn to the person's provider: then they do not run at
all, see "Allowing a turn on the person's own provider only").
`TurnGateContext.hasByoCredentials()` says whether the person has a provider
connected at all; per call, `paidBy` is the authority.

## `onTurnUsage`: one report per turn attempt

Fired in the background once an attempt has ended and every call it reported
(the session title included) has been through every plugin's `onModelCall`,
with `{ requestId, runId, sessionId, status, calls, platformCostUsd,
unpricedPlatformCalls }`. It waits at most 60 s for slow `onModelCall` hooks,
then reports without them (logged). It fires for every attempt that built the
agent (finished, failed or aborted: `status` says which), and for an attempt
that ended earlier but made calls (an event turn a plugin decided with
`ctx.llm`, a build that failed after reading a file). Not fired for an attempt
that made no call and never built the agent (a refused turn, a direct read
from request admission).

The contract a meter can rely on: **every call whose `ctx.session.runId` is
set is in exactly one `onTurnUsage`** (its attempt's), so a plugin may meter
in-turn calls from `onTurnUsage` alone and handle only calls without a run
(group summaries, channel routing before a run) in `onModelCall`. The one
exception: an attempt the object stops in the middle (a deploy, an eviction,
an object reset) gets no report; its calls reached `onModelCall` only, and
the run resumes as a new attempt with its own report.

## `onWake`: deferred work without a request

`ctx.requestWake(at)` (present when some plugin defines `onWake`) asks the
host to wake the person's object no earlier than about `at` (epoch ms). The
earliest requested wake is kept (one per object, `meta:pluginWakeAt` in DO
storage) and armed on the object's single alarm. When it comes due, the
housekeeping tick clears it and calls every plugin's `onWake(ctx)` (each
bounded to 30 s, a failure logged), with the person the object serves
(`ctx.user`, their deposited delegation when there is one), an empty
`ctx.session.id` and no run. A wake fires once: ask again for the next one.

A pending wake does not keep an idle working copy: when the person has been
away long enough for the object to evict its copy (5 days without a request),
the pending wake is dropped with it. The plugin's rows travel with the owner
copy; its next hook for that person (their next turn) is where the work
resumes. Each wake of an object whose database is closed opens it from DO
storage (as any housekeeping tick does), so ask for wakes sparingly (backoff,
not polling).

## State, delegation and background work

No new store: `ctx.kv` (`UserKvSurface`) is durable, per person, transactional
(`update` is an atomic read-modify-write), up to 256 KiB per value. Its
`idleTtlMs` slides on every read, so a time-boxed flag keeps its absolute
expiry in the value. Cost: every call is one SQLite transaction on the
person's file; a `get` of an existing row also writes (it bumps the row's LRU
counter and slides its TTL), a `get` of an absent row only reads. A gate that
reads a row which exists only for the few (a block) costs the many a read
only. Rows live in the person's own database and travel with
their encrypted owner copy. The person's delegation for an on-behalf call is
`ctx.user.ucanDelegation.raw` (on Matrix, task and channel turns the
delegation they deposited for the oracle). Best-effort work after the reply:
`ctx.background(promise)`.
