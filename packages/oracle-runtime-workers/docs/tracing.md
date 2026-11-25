# Tracing

A trace shows what one turn of your oracle did: the person's message, every
model call, every tool call, the reply, the tokens and the cost. The runtime
can send traces to two places. You pick one, both, or none. Nothing is traced
until you configure it.

This page is for the Workers runtime (`@ixo/oracle-runtime-workers`). The
IXO Traces tracer exists only there. The deprecated Node runtime
(`@ixo/oracle-runtime`) has LangSmith only, and gets no new tracing work.

## Pick one

| Choice                                                      | Where traces go                                          | You need                                                                        | Cost to you                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [A. LangSmith](#a-langsmith)                                | LangChain's LangSmith (US or EU)                         | A LangSmith account and API key                                                 | LangSmith's price per trace (below)                                          |
| [B. IXO Traces, hosted by IXO](#b-ixo-traces-hosted-by-ixo) | IXO's instance, `https://traces.ixo.earth` (EU)          | A project and a write key from IXO                                              | None from LangSmith. Ask IXO                                                 |
| [C. Your own IXO Traces](#c-your-own-ixo-traces)            | Your own copy of the service, on your Cloudflare account | Your Cloudflare account, the service's repo, a project and a write key you make | Your Cloudflare bill (a few dollars a month at a few hundred thousand turns) |
| [D. Both](#d-both-at-once-for-a-comparison-period)          | LangSmith and IXO Traces                                 | A and (B or C)                                                                  | Both                                                                         |

All choices are set in the Worker's environment. No code change is needed.

## A. LangSmith

### Turn it on

| Variable                | Kind   | What it does                                                                                                        |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `LANGSMITH_API_KEY`     | secret | Your LangSmith API key. Without it nothing is sent, whatever the other variables say.                               |
| `LANGSMITH_TRACING`     | var    | `true` traces every turn.                                                                                           |
| `LANGSMITH_TRACED_DIDS` | var    | Traces only these users: a comma-separated list of DIDs. `*` means everyone. Ignored when `LANGSMITH_TRACING=true`. |
| `LANGSMITH_PROJECT`     | var    | The LangSmith project name. Without it runs go to LangSmith's `default` project.                                    |
| `LANGSMITH_ENDPOINT`    | var    | The API URL. Leave it out for the US region. EU region: `https://eu.api.smith.langchain.com` (no trailing slash).   |

```jsonc
// wrangler.jsonc
"vars": {
  "LANGSMITH_TRACING": "true",
  "LANGSMITH_PROJECT": "my-oracle-mainnet",
  // EU accounts only:
  // "LANGSMITH_ENDPOINT": "https://eu.api.smith.langchain.com",
},
```

```bash
printf '%s' "$LANGSMITH_KEY" | npx wrangler secret put LANGSMITH_API_KEY
```

For a deployed oracle, a LangSmith key is region-bound: a US key does not
work against the EU endpoint.

The runtime reads these variables from the Worker's `env` only. It removes
LangChain's own switches (`LANGSMITH_TRACING`, `LANGCHAIN_TRACING`,
`LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING_V2`) from `process.env` when the
isolate loads, so LangChain never attaches its own unredacted tracer. Use
only the variables above.

### What it sends

Every run of the turn (the graph, its nodes, model calls, tool calls,
sub-agents), uploaded in batches by LangSmith's client from the user's
Durable Object. A model call's run holds the whole prompt the model read:
the system prompt and the conversation. Graph and middleware runs keep only
the newest 4 messages. Signed storage links have their signature removed.
No `process.env` values and no runtime block are sent. Each run's metadata
holds `user_did`, `user_id` (both the user's DID) and `client`.

The runtime does not wait for LangSmith's upload queue at the end of a turn.
The uploads run in the background of the user's Durable Object.

### What it costs

List prices on [langchain.com/pricing](https://www.langchain.com/pricing),
read on 25 Nov 2026:

- Plus plan: $39 per seat per month, with 10,000 base traces a month included.
- After that: $0.005 per base trace, so $5 per 1,000 traces. Base traces are kept 14 days.
- Longer retention (extended traces) costs extra.
- One trace is one turn: the root run and all its child runs.

Example: 280,000 turns a month cost about (280,000 − 10,000) × $0.005 =
$1,350 a month, plus seats. Your negotiated rate may differ. Check
Settings → Usage in LangSmith.

### LangSmith's v1 read endpoints end on 31 Jan 2027

LangSmith Cloud removes its legacy read endpoints, such as
`POST /api/v1/runs/query`, on 31 January 2027. They are deprecated since the
end of July 2026. Scripts and tools that read traces with them must move to
the v2 endpoints before then. A v2 query without `min_start_time` returns
only the last 24 hours. See LangSmith's
[migration guide](https://docs.langchain.com/langsmith/smithdb-sdk-migration).
Run ingestion is not on that list, so the runtime's uploads are not affected
as far as the list shows.

## B. IXO Traces, hosted by IXO

IXO Traces is IXO's own trace store. IXO runs one instance at
`https://traces.ixo.earth`. It stores each turn in the EU (Cloudflare R2 and
Durable Objects). It answers queries from scripts and Claude Code sessions.
It has no web UI yet.

Needs `@ixo/oracle-runtime-workers` 0.60.0 or later. Use 0.63.0 or later:
0.63.0 adds sub-agent model calls to the trace and to the turn's usage, the
size guarantee and the retry rules described below.

### 1. Get a project and a write key

Ask IXO for a project and a write key. Use one project per oracle and
network (for example `my-oracle-devnet`, `my-oracle-mainnet`) and one write
key per oracle Worker. A write key (`ixt_w_…`) can only send traces, to one
project. Sign-in for people is not ready yet, so today the IXO operator
makes the key. For an oracle on IXO's Cloudflare account the operator pipes
it straight into the Worker's secret, so nobody sees it.

### 2. Point the oracle at it

The tracer is on exactly when the Worker has `TRACES_API_KEY` and a
destination. Otherwise it is off and costs nothing.

| Setting           | Kind            | What it does                                                                                                                                                                                                                       |
| ----------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRACES_API_KEY`  | secret          | The write key (`ixt_w_…`).                                                                                                                                                                                                         |
| `TRACES`          | service binding | A binding to the traces Worker. Preferred: no public hop, no hostname. Works only when the oracle is on the same Cloudflare account as the traces Worker (IXO's account for IXO's instance). Used when both are set.               |
| `TRACES_ENDPOINT` | var             | The base URL, `https://traces.ixo.earth`. Use it when the oracle is on another Cloudflare account. Must be `https://` (`http://` only for `localhost`, `127.0.0.1`, `[::1]`); anything else turns the tracer off with one warning. |

On IXO's Cloudflare account:

```jsonc
// wrangler.jsonc (top level, next to "vars")
"services": [
  { "binding": "TRACES", "service": "ixo-langsmith-traces" },
],
```

On any other account:

```jsonc
// wrangler.jsonc
"vars": {
  "TRACES_ENDPOINT": "https://traces.ixo.earth",
},
```

The secret:

```bash
printf '%s' "$TRACES_WRITE_KEY" | npx wrangler secret put TRACES_API_KEY
```

With a split layout (an oracle script and a gateway script), put the binding
and the secret on the oracle script: the user objects send the traces.
Deploy the oracle after the change.

### 3. Read the traces

Ask IXO for a read key for your project. The service's guide
[querying-from-claude-code.md](https://github.com/ixoworld/ixo-langsmith-traces/blob/main/docs/querying-from-claude-code.md)
shows the `ixt` script and common questions. The service also answers on
LangSmith-shaped `/api/v1/*` routes.

## C. Your own IXO Traces

You can run your own copy of the service on your own Cloudflare account.
Your traces then never leave your account.

1. Get the service's code: [`ixoworld/ixo-langsmith-traces`](https://github.com/ixoworld/ixo-langsmith-traces).
   The repository is private today: ask IXO for access.
2. Follow its [runbook](https://github.com/ixoworld/ixo-langsmith-traces/blob/main/docs/runbook.md):
   "Resources" (an R2 bucket, a D1 database), "Secrets", "Deploy", then
   "Bootstrap" for a project and keys. The runbook is written for IXO's
   instance: first change the account-specific values in its
   `wrangler.jsonc` (`account_id`, the Worker `name`, the R2 bucket, the D1
   database id, the rate limiter ids and the custom domain) to your own.
3. Point your oracle at it as in B: a `TRACES` binding to your Worker's
   name when the oracle is on the same account, else `TRACES_ENDPOINT` set
   to your hostname.

The runbook's "Cost model" estimates about $20 a month at list price for
300,000 turns a month kept 30 days, before Cloudflare's monthly allowances
(Workers Paid plan, $5 a month).

## D. Both at once, for a comparison period

Set A and B (or C) together. The two are independent:

- Each turn goes to both. LangSmith still charges per trace.
- Both get the same runs with the same run ids. The IXO Traces `trace_id` is
  the root run's id, so the same turn can be found in both.
- Neither tracer adds a model call, and the turn's usage is counted once.
  Billing and metering through `onModelCall` are not affected. The test
  `src/do/turn-traces.test.ts` ("IXO Traces and LangSmith on the same turn")
  proves this on a real user object turn.
- LangSmith may trace only some users (`LANGSMITH_TRACED_DIDS`). IXO Traces
  always traces every turn. Compare the same turns.
- The two may show cost differently. IXO Traces shows the cost the provider
  (OpenRouter) reported for each call. LangSmith shows its own figure.

To end the comparison, delete `LANGSMITH_API_KEY`
(`npx wrangler secret delete LANGSMITH_API_KEY`) and remove the
`LANGSMITH_*` vars.

## How IXO Traces works

### Which turns

Every agent turn of a user object: Portal, Matrix, channel (WhatsApp,
Telegram, web) and task turns. A turn with supplied context only is never
traced, by either tracer. The session-title call is left out: it runs after
the reply.

### What one turn sends

Two requests, both from the user's Durable Object, both after or beside the
reply. The reply never waits for them.

1. A start marker when the turn starts (`POST /v1/ingest/turns/start`): the
   trace id, thread, user, start time and name. If the object dies during
   the turn, this marker is all that is left. The service shows that turn
   as `interrupted` after 10 minutes.
2. The finished turn, once, as gzip JSON (`POST /v1/ingest/turns`):
   - the trace id, thread id (the session), user id, start and end time,
     status (`success`, `error`, `interrupted`) and error;
   - `user_text` (the person's message) and `reply_text` (the final reply),
     each cut at 8,000 characters;
   - `usage`: input, cached and output tokens and the USD cost of every
     model call of the turn, each counted once;
   - metadata: `oracle_did`, `network`, `channel`, `runtime_version`,
     `request_id`, `served_model`, `fallback`, `user_did`, `user_id`,
     `client`, `thread_id`;
   - every run of the turn in LangSmith's run shape: model calls with
     tokens, cost and model, tool calls, graph runs.

Sub-agents (0.63.0 and later): a sub-agent's model and tool calls are
nested under the tool call that ran it. Their tokens and cost count in the
turn's usage once. Model calls made outside the graph (the capability
router, attachment reading, the summarizer, the safety check) are sent as
runs tagged `outside_graph`, directly under the root.

Not sent: streamed tokens (only the first token's time), LangChain's class
descriptions (`serialized`), `process.env` values, the runtime block, and
the signature of every signed storage link.

### Size and truncation

| Limit          | Tracer               | Service |
| -------------- | -------------------- | ------- |
| Turn, unzipped | 15 MiB of UTF-8 JSON | 16 MiB  |
| Turn, gzipped  | 7.5 MiB              | 8 MiB   |
| One payload    | 4 Mi characters      | —       |
| Runs per turn  | 5,000                | 5,000   |

The tracer stays under the service's limits, so the service never refuses a
turn for its size. A normal turn is about 1 MiB before gzip.

When a turn is too big, the tracer replaces payloads with
`{"_truncated":{"chars":N}}`, largest first, in a fixed order: model call
settings, prompts, graph state, events, model replies, tool results, tool
inputs, then metadata. If it is still too big, it leaves out the last runs
(a parent always stays with its children). The root run and the turn's own
fields always stay. The turn's metadata then says `truncated: "true"`,
`truncated_payloads` and `omitted_runs`.

### Retry and drop rules

One request per turn. Nothing is stored for later.

| Answer                                      | What the tracer does                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 200, 201                                    | Sent.                                                                                                                                        |
| 202                                         | Sent. The service stored the body and indexes it within 5 minutes.                                                                           |
| 429                                         | Waits `Retry-After` plus up to 1 s, then tries once more. A `Retry-After` over 30 s drops the turn. A start marker's 429 is dropped at once. |
| 503, other 5xx, 408, timeout, network error | One retry after 0.25 to 1 s (a 503's `Retry-After` is honoured up to 30 s). Then dropped.                                                    |
| 409                                         | Counted as a conflict. Never retried.                                                                                                        |
| 410 (or 404 `not_found`)                    | Dropped. Every send with that write key pauses 10 minutes in that isolate.                                                                   |
| Other 4xx (401, 403, 413, 400, …)           | Refused. Never retried.                                                                                                                      |
| "Contract version not accepted"             | Every send of the isolate pauses 10 minutes.                                                                                                 |

Timeouts: 15 s for a turn, 5 s for a start marker. Per user object, turns
are sent one at a time; at most 8 turns and 2 markers wait. More are skipped
and counted. A retry sends the same bytes, so it never stores a duplicate.
A failed trace never fails or slows the turn.

## Privacy

Traces hold personal data. Treat a trace store like the conversations
themselves.

- A trace holds what the person wrote, the oracle's reply, tool inputs and
  outputs, and, in each model call, the full prompt with the conversation.
- `user_id` is the user's DID (also in the metadata as `user_did` and
  `user_id`). Both LangSmith and IXO Traces store it.
- IXO Traces stores bodies in the EU and keeps them for the project's
  retention (1 to 365 days, default 30). A project owner can erase one
  person's turns (`DELETE /v1/projects/:p/users/:user_id`) or delete the
  project. Erasure is not instant: the service's security notes give the
  recovery windows.
- LangSmith keeps base traces 14 days in the region of your account.
- Signed storage links lose their signature before any trace leaves the
  runtime. Keys and `process.env` values are never sent.
- The runtime's `[traces]` log lines carry ids, counts, sizes and status
  codes only: never content, keys or DIDs.
- Supplied-context turns are never traced.

## Check that it works

1. Send one message to the oracle.
2. Read the oracle's Workers Logs (the Cloudflare dashboard, or the
   Workers Logs API). Do not use `wrangler tail`: attaching or detaching a
   tail resets the oracle's Durable Objects. Look for one line per turn:
   `[traces] turn 0192ab34…: N runs, <raw> → <gzip> bytes, built in X ms`.
3. Look for failure lines. None should appear: `[traces] … not stored`,
   `refused`, `dropped`, `conflict`, `not sent`.
4. With a read key, look the turn up:
   `scripts/ixt get '/v1/projects/<slug>/turns?limit=1&include=meta'`.

The tracer does not log a line for a successful send. "Built" and no failure
line means it was sent.

For LangSmith, open the project in LangSmith and find the turn by its thread or user.

## Turn it off

- IXO Traces: delete the secret (`npx wrangler secret delete TRACES_API_KEY`),
  or remove the `TRACES` binding and `TRACES_ENDPOINT` and deploy.
- LangSmith: delete `LANGSMITH_API_KEY`, or remove `LANGSMITH_TRACING` and
  `LANGSMITH_TRACED_DIDS` and deploy.

## Troubleshooting

Log lines read `[traces] turn <id>… (<bytes> bytes) <outcome>: HTTP <status> <code>`.

| Status | Log line                                        | Cause                                                                                                                                                             | Fix                                                             |
| ------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 401    | `refused: HTTP 401 unauthenticated`             | The key is wrong, revoked or expired, or its project was deleted. A read key gets 401 or 403.                                                                     | Get a new write key (`ixt_w_…`) and put it in `TRACES_API_KEY`. |
| 409    | `conflict: HTTP 409 …`                          | Another body is stored under this trace id. Should never happen.                                                                                                  | Report it to IXO with the trace id.                             |
| 410    | `dropped: HTTP 410 gone …; … paused for 10 min` | The project is deleted or being deleted.                                                                                                                          | Get a project and key that exist, or turn tracing off.          |
| 413    | `refused: HTTP 413 …`                           | The turn was over the service's size limit. The tracer prevents this from 0.63.0.                                                                                 | Move to 0.63.0 or later.                                        |
| 429    | `dropped: HTTP 429 …`                           | The write key is over its rate limit (100 requests or 42.7 MiB per 10 s per Cloudflare location). After many refused keys in a minute, refused keys also get 429. | Check for 401s first. Else ask IXO to raise the limit.          |
| 503    | `not stored: HTTP 503 after 2 attempts`         | Storage or the index was down. That turn is lost.                                                                                                                 | Check the Cloudflare status page. Report it if it lasts.        |

Other lines:

| Log line                                                    | Cause and fix                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| No `[traces]` line at all                                   | The key or the destination is missing, or the runtime is older than 0.60.0. Check both and the version. |
| `TRACES_ENDPOINT is not an https:// base URL …`             | Fix the URL. Tracing is off until then.                                                                 |
| `not sent: N trace requests already waiting`                | The service is slow. Turns are skipped rather than held in memory.                                      |
| `turn … truncated: N payloads dropped, M runs left out`     | The turn was over 15 MiB. It was sent, cut down.                                                        |
| `does not accept contract version 1 …: … paused for 10 min` | The service and the runtime disagree on the contract. Tell IXO.                                         |

## More detail

- [configuration.md](configuration.md#ixo-traces-turn-tracer): the tracer's
  internals (callbacks, build, contract version).
- [operations.md](operations.md#turn-traces-ixo-traces-are-per-durable-object-too):
  per-object behaviour.
- The service's [sending-traces.md](https://github.com/ixoworld/ixo-langsmith-traces/blob/main/docs/sending-traces.md)
  and [api.md](https://github.com/ixoworld/ixo-langsmith-traces/blob/main/docs/api.md).
