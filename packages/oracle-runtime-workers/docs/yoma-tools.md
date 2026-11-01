# Yoma tools (yoma plugin)

The `yoma` plugin (`src/plugins/yoma/`) lets an oracle act as Yoma's assistant:
it lists Yoma's programmes and jobs the way jambo.yoma.world does, takes a
person through a job's application or claim form one question at a time, and
says whether their logged work was approved and paid. It is **not** in
`BUNDLED_WORKERS_PLUGINS`: a host imports it from the subpath, so
`survey-core` only lands in oracles that use it. Even there it is not
evaluated at Worker startup: both tools await `loadSurveyCore()`
(`engine.ts`) on their first call, a dynamic `import('survey-core')` that the
bundler keeps behind a lazy initialiser. Evaluating it at startup had pushed
an oracle with this plugin to the Workers startup-time limit (deploy error
10021). Only type imports of `survey-core` are allowed in the plugin (an
ESLint rule); its classes come from `surveyCore()` once loaded.

```ts
import {
  YomaPlugin,
  workersAiClefRunner,
} from '@ixo/oracle-runtime-workers/plugins/yoma';

createOracleWorker({
  config,
  plugins: [
    new YomaPlugin({
      getClef: () => (env.AI ? workersAiClefRunner(env.AI) : undefined),
    }),
  ],
  manifestOverrides: { yoma: { visibility: 'always' } },
});
```

The manifest is `on-demand`; Yoma's assistant makes it always-on with
`manifestOverrides`. No new env var: the network comes from `NETWORK`,
Blocksync from `BLOCKSYNC_GRAPHQL_URL`, chain REST from ixo-chain's
`CHAIN_REST_URL` rule.

| Tool          | Input                                                                                                                                      | Effect |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `yoma_lookup` | `{ requests: 1–6 }`, each a strict `kind`: `programmes`, `programme_jobs`, `job`, `my_drafts`, `my_work`                                   | read   |
| `yoma_form`   | one flat object: `action` (next, answer, skip, section, review, submit, discard), `form`, `collectionId`, and the fields that action needs | write  |

`yoma_form` is a single object, not a union: a bare top-level `oneOf` breaks
some providers' tool schemas (`node-parity.md`). The handler checks the
fields each action needs (`answer`: `field`, `reply`; `skip`: `field`;
`section`: `section`, `addAnother`; `discard`: `confirmed`) and answers a
missing one with `invalid_input` naming it. `submit` sends only with
`confirmed: true`, and the plugin checks the consent itself: it records
which pages of the read-back (`review`, or an unconfirmed `submit`) were
shown for which answers (`updatedAt`) in which request, and sends only on a
**later** request (the person's reply) with the same answers and every page
shown. A `confirmed: true` in the same request as the read-back, after an
answer changed, or with a page unread answers `needs_confirmation` with the
next page, and no card is requested.

Identity comes from the runtime: the person's address is
`ixoAddressOf(ctx.user.did)`. No tool takes an account.

**Prompt footprint** (`z.toJSONSchema` of both schemas, the two
descriptions, the operating guide and the manifest's JSON, measured
2026-10-30): 5,033 characters, against ixo-chain's 5,462 measured the same
way.

## Where the data comes from

| Data                   | Source                                                                                                                                 | Kept per isolate             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Programmes (the cards) | Jambo worker `GET /v1/entities` (mainnet only: `JOB_LIST_URLS`), at most 50                                                            | 5 min; a failed build 30 s   |
| Hidden jobs            | Jambo worker `GET /v1/collections/<entity>`                                                                                            | with the list                |
| Jobs                   | Blocksync `claimCollections(filter: { entity: { in }, state: { equalTo: 0 } })`, pages of 500, at most 4; 300 kept                     | with the list                |
| Names, places, pay     | the entity's `settings.Profile` document; the claim form's title; `payments.approval`                                                  | with the list                |
| Protocol entities      | Blocksync `entities(filter: { id: { in } })`                                                                                           | 10 min, shared by every tool |
| Forms                  | the protocol's first linked resource whose id contains `#bco` (application), else `#vct`, else `surveyTemplate` (claim), up to 128 KiB | 10 min, LRU: 50 forms, 5 MB  |
| Can log work           | chain REST `/cosmos/authz/v1beta1/grants?granter=<admin>&grantee=<person>`                                                             | never                        |
| Logged work            | Blocksync `claims(filter: { agentAddress }, orderBy: SUBMISSION_DATE_DESC)`, `first` ≤ 20                                              | never                        |
| Drafts                 | the person's own `ctx.kv`, namespace `yoma`                                                                                            | until sent or deleted        |
| Sent work              | the same, key `sent`: the last 50 sent applications and claims (claim id kept)                                                         | newest 50                    |

A programme is an entity on the worker's list, in its order, shown even when
nothing is open. A job is one of its claim collections, minus the hidden
ones and those the chain would refuse a claim on (x/claims `SubmitClaim`):
state not OPEN (`CollectionState` OPEN = 0, PAUSED = 1, CLOSED = 2; Blocksync
stores the number), not started, ended, or full. Jambo lists all but the
hidden ones. Blocksync keeps collection ids as text (its order puts "10"
before "9"), so the pages are read in key order and the jobs sorted as
numbers. At most 300 jobs are kept; `programmes` says `truncated: true` when
more were open or more pages were left unread. The form matching is Jambo's
own (`jambo-yoma-v2` `screens/collectionForm.tsx`: `includes('#bco')`,
`includes('#vct')`, then `includes('surveyTemplate')`), so chat and Jambo
always open the same form.

**Bot-only jobs (optional, testing only).** A host may pass `botOnlyJobs:
[{ programme, collectionId }]`: test collections offered in chat but not on
jambo.yoma.world. It exists strictly to test on a collection in production
(real cards, claims and payments on mainnet) without touching what partners
and opportunity providers see or get on Jambo. Real opportunities belong on
Jambo's list, not here. Closing or pausing the collection ends the test.
Their programmes come after Jambo's (one Jambo lists keeps its place) and a
programme Jambo does not list shows only its bot-only jobs. Jambo's hide
list does not apply to them; the chain's rules (open, dates, quota) do. Ids
that are not an entity DID and a collection id are left out. They are read
on any network, not only mainnet.

**A hide list that cannot be read** (an error other than a 404) marks only
that programme `unavailable: true` with none of its jobs: a job it hides
must never be offered, and the other programmes stand. `programme_jobs` for
it answers `unavailable`, retryable. A 404 is a programme with nothing
hidden.

One catalog build runs per isolate and network at a time, on its own: its
own deadline (the 20 s tool budget from its start), its own abort (only that
deadline) and its own permit pool (`yoma-catalog:<network>`, ixo-chain's 5
permits), so the caller that started it can leave without failing anyone
else; every caller waits for it with its own abort. The hide lists, the
collection pages and the programmes' entities are read at once, then the
profiles together with the protocols and their forms' titles; protocol
entities are read 100 per Blocksync read, never dropped. Each hide list,
profile and form in a build keeps its own unhealthy mark (`healthPerUrl`),
so one 503 holds back only that address after its own retry. A complete list
is kept 5 minutes; a failed build, or one with a piece missing (a hide list,
a profile, a protocol, a job's name: `incomplete`), 30 seconds.

The list is per isolate. Workers' Cache API (`caches.default`) could share it
across isolates, but the plugin API offers plugins no cache surface and
nothing in the runtime uses it, so it is not used here; a host that wants it
can add a cache in front of the job-list worker.

## Drafts

One key per draft (`draft:<form>:<collectionId>`) and an index key
(`draft-index`) of the **open** ones, so a draft never shares the 256 KiB
value cap with another. Each draft is parsed on its own: one that does not
parse is counted in `my_drafts` as `unreadable` and skipped, never
overwritten (it can be deleted on request). Every write runs inside
`ctx.kv.update` on the draft as stored (the form is opened again from the
stored answers there), is validated against the draft schema, and is refused
when invalid; so two answers that arrive at once are both kept. A person has
at most 20 open drafts (sent ones do not count), a draft at most 30 files, a
repeating section at most 50 items; a reply is at most 4,000 characters by
schema. A write past the storage caps (`UserKvLimitError`) answers
`too_large`, not retryable, and leaves the draft as it was. A new draft
saves the form's default values (`openModel` without data); a saved draft
opens exactly as saved.

**Sent work.** A claim whose card succeeded moves to the `sent` record (its
claim id kept) and its draft goes, so the next `next` starts a new claim on
the same job: one `SubmitClaimAuthorization` constraint with `agent_quota`
N allows N claims (x/claims `authz.go` `Accept` takes one per claim and drops
the constraint at 0), and the chain has no one-claim-per-agent rule. A sent
application keeps its draft (`next` answers `submitted`) but leaves the
index; `discard` deletes it, so they can apply again. `my_drafts` lists the
open drafts and the last five sent.

The single-value book under `drafts` existed only on unreleased branches and
is ignored.

## Rules

1. **Reads never throw.** Every read goes through ixo-chain's `http.ts`
   (`exchange` / `withRetry`): per-attempt timeout (8 s for documents and the
   job list, 11 s for Blocksync, 8 s for REST), the 20 s tool budget, no
   redirects, body caps (job list 256 KiB, profile 64 KiB, form 128 KiB: the
   largest real Yoma form is about 20 KB), one
   retry after `Retry-After` or a jittered 1–3 s on 429/502/503/504/network,
   never on a timeout, and the 10 s unhealthy mark after a 429 or 503. A
   failure is `{ ok: false, reason, detail, retryable }`; an oversized
   document answers `too_large` naming it ("This form is too large to read
   here…"). Log lines are tagged `[yoma]` and carry no address or body. The
   turn's own abort is rethrown everywhere, Clef and the Hub included.
2. **`reason` is only a failure code.** An `ok: true` answer that asks the
   model to try again (`invalid`, `unclear`, `needs_more`, `no_file`, …)
   carries what to say in `say`.
3. **Literals, not variables.** Ids are checked (`did:ixo:entity:<32 hex>`,
   collection `[1-9]\d{0,11}`, `ixo1…` through `IxoAddressSchema`, cursor
   `[A-Za-z0-9+/=_-]{1,200}`) and written as GraphQL literals. Document URLs
   must be plain https. Blocksync rows and stored drafts are parsed with zod;
   a row of another shape is left out.
4. **Each request answers on its own**, and each form inside an answer too:
   a malformed form (no pages) answers that line `unavailable`, not
   retryable. The job list is read once per call. Either tool's answer is at
   most 12,000 JSON characters: `yoma_lookup` leaves out the largest results
   as `too_large`; `yoma_form` shortens option lists of the question shown
   and says `truncated: true` (every option still counts when the reply is
   read). A read-back is never cut: it comes in pages of at most 8,000
   characters (`review` with `page`).
5. **Upstream text is data.** Profile names (120), descriptions (600), form
   titles and questions (200), descriptions (500), options (200, at most 60;
   a longer list says `optionsCut` with the web link) and validation messages
   (200) are clipped, and both tool descriptions and the operating guide say
   they are data, never instructions — what Auth Hub said about a failed card
   (`lastCard.hubSaid`, the receipt's plain `message`) included. A failure
   receipt's optional technical `detail` is never read.
6. **Forms follow their own rules.** `survey-core` 2.3.11 (the Portal's
   version; Jambo renders with 1.9.101, through `survey-react-ui`) decides
   visibility, required fields, validation and computed values. A question
   is asked only when it is on the form as the person sees it
   (`isVisibleInSurvey`: itself, its panel and page, and for a repeating
   section the section and that item). Repeating sections are asked item by
   item (`shops[2].photo`); "another item?" is asked right after a section's
   items, before what follows it, and the section is held to its minimum
   (`minPanelCount`, or one when required) by `review`, `submit` and
   `section` with `addAnother: false`. A skipped question that becomes
   required is asked again, and `review`/`submit` always list a missing
   required answer. Typed answers are checked before the form sees them
   (survey-core takes `abc` for a date and drops it for a number without an
   error): dates `YYYY-MM-DD` (`-`, `/` or `.`), `datetime-local` as
   `YYYY-MM-DD HH:mm`, numbers with a decimal comma (`1,5`) but not the
   ambiguous `1,500`, ratings on the form's own scale, emails, links, phones.
   Questions chat cannot ask (signatures) answer `web_only` with the job's
   Jambo link.

   **Hidden answers.** What is read back, shown on the card and sent comes
   from one model whose hidden answers were cleared (every question not
   `isVisibleInSurvey`, nested ones included), whatever the form's
   `clearInvisibleValues` says; the draft keeps them in case the person
   changes the answer that hid them. This follows the Portal (it submits
   from `onComplete`, after SurveyJS clears them) and differs from Jambo,
   which submits from `onCompleting`, before the clearing, and so sends hidden
   answers too.

   **The map question.** Jambo's `map-grid-selector` is registered so a
   WhatsApp pin becomes a cell like Jambo's: `geoId` (geohash at the form's
   `gridPrecision`, default 7, clamped to 1–12), `latitude`, `longitude`,
   `gridPrecision`, and `placeName` from the pin's name. Jambo also stores
   what HERE reverse-geocoding returns (`placeIdentifier`, `placeDistance`,
   `postalAddressName`, country, state, county, city, district, road, postal
   code and house fields); chat produces none of those.

7. **Choices.** The options are the form's choices, then its "None",
   "Refuse to answer" and "Don't know" items when switched on (found by
   identity, `noneItem`/`refuseItem`/`dontKnowItem`, never by value: a
   regular choice may be valued `none`), each stored with the form's own
   value; on a checkbox those go on their own. "Other" is the form's
   `otherItem`; an own answer is stored where the form keeps it (a
   `-Comment` value, or the value itself with `storeOthersAsComment: false`).
   With a Clef runner (`getClef`), Clef reads the reply against the options
   at the survey thresholds (0.7 accept, 0.3 maybe, 0.6 genuine write-in),
   for at most 4.5 s; without one, when Clef fails, or when it answers late,
   only an option number or the exact option text counts and anything else
   is `unclear`. When the options are themselves numbers, a typed number is
   read only as an option's text, never as a position.
8. **Files** come from the turn's `ctx.session.channel.attachments`. **Hard
   dependency:** that field arrives with the runtime release that carries
   WhatsApp files (PR 422, with gateway `feat/whatsapp-media`); without it
   every file question answers `no_file` and a claim with a required file
   cannot be sent from chat. Each file is checked (https link, sha256, size)
   and matched against the question's `acceptedTypes`; a file already in the
   draft (same sha256) answers `duplicate`. The gateway's link is
   `<origin>/media/<binding>/<id>?exp=<unix s>&sig=…`, valid 30 days: before
   a claim is sent, a file whose `exp` is less than an hour away (the card's
   15-minute review and the Hub's upload) leaves the draft and the answer is
   `file_expired`, asking for it again. Auth Hub checks only that the link is
   https on the gateway's host under `/media/`; a lapsed link would fail the
   card at its `evidence` step.
9. **Sending**, only on the recorded consent (see above). An application
   goes out as the application card (`ixo.bid.submit.v1`, role `SA`, as
   Jambo's bids), logged work as the claim card (`ixo.claim.submit.v1`) —
   introduced in `@ixo/action-protocol` 0.7.0 at Hub protocol level 5 (this
   runtime declares level 6, which keeps them). The plugin reads
   `ctx.hubActions.capabilities()`: when the Hub does not offer that kind it
   answers `not_enabled`, not retryable ("…isn't switched on for this
   oracle's Auth Hub account yet"). The network is the account's
   (`capabilities.network`; the Hub names it when bank sends or chain
   transactions are on), else the oracle's `NETWORK`; one that differs from
   the oracle's answers `unavailable`, not retryable. An invalid `NETWORK`
   reads nothing (no mainnet fallback).

   **The card's rows** are exactly the answers of the `data` it sends,
   as Auth Hub checks them (`submissionSummaryIssue`, `@ixo/action-protocol`
   0.7.0; a mismatch is a 400): objects and arrays of objects are walked
   into, every other value is an answer, and each answer gets one row,
   `field` its dot path (`name`, `shops.1.name`, `where.latitude`), `value`
   its `submissionDisplayValue` (the stored value: `ZA`, `true`, `2026-09`),
   and a label from the form: the question's title, a repeating section's
   item as "Participants 2 · Email", a map pin's parts as "Where · latitude",
   "Where · grid cell", "Where · place" (with several pins, "Where 2 ·
   place"), an own "Other" answer as "Country (own answer)". The read-back
   in chat is the same rows, page by page, with what a choice means in the
   form's words beside its stored value (`means: "South Africa"`) and the
   files listed apart (the card shows files as files: an evidence `field`
   never holds an answer). A claim of files only sends `data: "{}"` and no
   rows. More than 100 answers, an answer longer than 2,000 characters, a
   key the protocol refuses (empty, or with a `.`) or a value with no
   display form is never cut or split: the read-back says `cannotSend` and
   `submit` answers `too_large` with the Jambo link. Every card is checked
   with `submissionSummaryIssue` before it is sent. The claim card also
   carries one `evidence` entry per file still answering a visible question
   (`shops[2].photo` → `shops.2.photo`). On approval (the person ticks
   consent on the Hub page) the Hub uploads the files to the collection's
   claims lane as the person, signs the answers, saves the claim to the
   claims bot and submits it on chain.

   **Request keys.** Each send has its own key: SHA-256 of the owner's DID,
   the run, the tool call and the draft's `cardAttempt` (Auth Hub keys are
   unique per oracle account and 1–120 characters). The runtime binds a key
   to the run and request that reserved it (`HubActionStore.reserve`), so a
   retry on a later message needs a new key; a send that fails bumps
   `cardAttempt`. What stops a second card is the draft's `card`, set as
   soon as one is made.

   **Hub refusals** come back in plain words, as the hub-actions plugin
   relays them: a typed refusal (`HubActionRefused`) in the runtime's words,
   retryable only when Auth Hub answered 429 (`rate_limited`), 503 or 504
   (its `httpStatus`), else `refused` (`expired` for a lapsed request); an
   HTTP status the client did not type, by code (429/503/504 retryable;
   401/403, 413 and others not); a timeout, retryable.

   **The card's outcome** is read when the draft is next touched (each read
   bounded to 3 s through `status`'s `timeoutMs`; `my_drafts` asks about at most three cards). `succeeded`:
   sent, with the claim id from `ixo.claim.submission.v1`. `declined`,
   `expired`, `cancelled`, `failed`: the card is cleared, `cardAttempt`
   bumped, and a failed card's step and plain `message` kept as `lastCard`
   (`stoppedAt`, `hubSaid`) until the next card. `authorized`, `submitted`,
   `unknown` are **in flight** — the Hub's cron finishes the steps (at most 5
   transient failures or 30 minutes, then `failed`) and a claim can sit at
   `unknown` until the chain settles — so they are never cleared and never
   sent again, whatever the time; answers, skips and sections stay locked
   and `discard` is refused until a final outcome, or a day after the card's
   expiry with none. No outcome yet: cleared only when Auth Hub's
   `reviewStatus` is `expired` (it also records the `expired` outcome
   itself within a minute of expiry); a read that finds no such action in
   the owner's store (`held: false`) leaves the card as it is.

   **Known gap:** if the Hub made a card but its answer never arrived (a
   timeout), the next send makes a second card: the first is not known
   locally. The person sees both; the Hub page shows each.

10. **Instant permission (optional).** A host may pass
    `instantPermission: { allows(collectionId), grant({ collectionId, admin,
address, answers, signal }) }`. For a collection it `allows`, `submit` of a
    finished application sends no card and **no bid: the application itself
    is not sent to the programme**; the person is told so, and the host gets
    the answers (`answers`, hidden ones and files left out) to record if it
    must. The plugin records the call on the draft before making it and makes
    it at most once per application (a call that threw may be made again,
    one that never answered is not: `permission_pending`, and they can delete
    the application and apply again); `grant` must still be idempotent. A
    grant that throws answers `unavailable`, retryable; the turn's abort is
    rethrown. On success the application moves to the sent record and its
    draft goes, the permission is read on chain again, and the answer is
    `can_log_work` ("it can take a few seconds to show" when not visible
    yet). `next` on that application then answers `submitted` while the
    permission lasts, and starts a fresh application once it is used up. A
    claim without permission answers `apply_first` instead of
    `not_accepted`. Without the hook, or when `allows` is false, every job
    waits for the operator to accept the application through the bids bot.
    The plugin holds no wallet.

## Known limits

- **Lockfile.** `@ixo/action-protocol` is pinned to 0.8.0, which is not on
  npm yet: `pnpm-lock.yaml` must be regenerated once it is published.
- **Mainnet only for programmes**: the Jambo worker has no testnet or devnet
  list.
- **Pay** reads as an amount only for USDC (`ibc/6BBE…F97B`, "$1.27") and
  IXO; any other reward reads as "a reward".
- **Names of logged work** come from each collection's claim form; a form
  that cannot be read shows "Opportunity <id>".
