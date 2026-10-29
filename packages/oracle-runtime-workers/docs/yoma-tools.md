# Yoma tools (yoma plugin)

The `yoma` plugin (`src/plugins/yoma/`) lets an oracle act as Yoma's assistant:
it lists Yoma's programmes and jobs the way jambo.yoma.world does, takes a
person through a job's application or claim form one question at a time, and
says whether their logged work was approved and paid. It is **not** in
`BUNDLED_WORKERS_PLUGINS`: a host imports it from the subpath, so
`survey-core` only lands in oracles that use it.

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
`confirmed: true`, which the model passes only after the person clearly said
yes to the review it read back; without it the answer is
`needs_confirmation` with the answers, and no card is requested.

Identity comes from the runtime: the person's address is
`ixoAddressOf(ctx.user.did)`. No tool takes an account.

**Prompt footprint** (`toJsonSchema` of both schemas, the two descriptions,
the operating guide and the manifest): 4,755 characters, against ixo-chain's
7,403.

## Where the data comes from

| Data                   | Source                                                                                    | Kept per isolate             |
| ---------------------- | ----------------------------------------------------------------------------------------- | ---------------------------- |
| Programmes (the cards) | Jambo worker `GET /v1/entities` (mainnet only: `JOB_LIST_URLS`), at most 50               | 5 min; a failed build 30 s   |
| Hidden jobs            | Jambo worker `GET /v1/collections/<entity>`                                               | with the list                |
| Jobs                   | Blocksync `claimCollections(filter: { entity: { in } })`, up to 1,000 read, 300 kept      | with the list                |
| Names, places, pay     | the entity's `settings.Profile` document; the claim form's title; `payments.approval`     | with the list                |
| Protocol entities      | Blocksync `entities(filter: { id: { in } })`                                              | 10 min, shared by every tool |
| Forms                  | the protocol's `#bco` (application) and `#vct` / `#surveyTemplate` (claim), up to 512 KiB | 10 min, LRU: 50 forms, 5 MB  |
| Can log work           | chain REST `/cosmos/authz/v1beta1/grants?granter=<admin>&grantee=<person>`                | never                        |
| Logged work            | Blocksync `claims(filter: { agentAddress }, orderBy: SUBMISSION_DATE_DESC)`, `first` ≤ 20 | never                        |
| Drafts                 | the person's own `ctx.kv`, namespace `yoma`                                               | until submitted or deleted   |

A programme is an entity on the worker's list, in its order, shown even when
nothing is open. A job is one of its claim collections, minus the hidden
ones, the ended ones and the full ones (Jambo still lists the last two).
After that filter at most 300 jobs are kept and `programmes` says
`truncated: true` when more were open.

**A hide list that cannot be read** (an error other than a 404) marks only
that programme `unavailable: true` with none of its jobs: a job it hides
must never be offered, and the other programmes stand. `programme_jobs` for
it answers `unavailable`, retryable. A 404 is a programme with nothing
hidden.

One catalog build runs per isolate at a time; a call during a build waits
for it. A build reads at most 6 upstreams at once.

## Drafts

One key per draft (`draft:<form>:<collectionId>`) and an index key
(`draft-index`), so a draft never shares the 256 KiB value cap with another.
Each draft is parsed on its own: one that does not parse is counted in
`my_drafts` as `unreadable` and skipped, never deleted (it can be deleted on
request). A person has at most 20 drafts, a draft at most 30 files, a
repeating section at most 50 items; a reply is at most 4,000 characters by
schema. A write past the storage caps (`UserKvLimitError`) answers
`too_large`, not retryable, and leaves the draft as it was. The single-value
book under `drafts` existed only on unreleased branches and is ignored.

## Rules

1. **Reads never throw.** Every read goes through ixo-chain's `http.ts`
   (`exchange` / `withRetry`): per-attempt timeout (8 s for documents and the
   job list, 11 s for Blocksync, 8 s for REST), the 20 s tool budget, no
   redirects, body caps (job list 256 KiB, profile 64 KiB, form 512 KiB), one
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
   as `too_large`; `yoma_form` shortens answer values and option lists and
   says `truncated: true`.
5. **Upstream text is data.** Profile names (120), descriptions (600), form
   titles and questions (200), descriptions (500), options (200, at most 60)
   and validation messages (200) are clipped, and both tool descriptions and
   the operating guide say they are data, never instructions.
6. **Forms follow their own rules.** `survey-core` 2.3.11 (the Portal's
   version) decides visibility, required fields, validation and computed
   values, on one model per action. Repeating sections are asked item by item
   (`shops[2].photo`), held to their minimum (`minPanelCount`, or one when
   required) by `review`, `submit` and `section` with `addAnother: false`.
   Jambo's `map-grid-selector` is registered so a WhatsApp pin becomes the
   same geohash cell Jambo stores, at a precision clamped to 1–12. Questions
   chat cannot ask (signatures) answer `web_only` with the job's Jambo link.
7. **Choices.** With a Clef runner (`getClef`), Clef reads the reply against
   the options at the survey thresholds (0.7 accept, 0.3 maybe, 0.6 genuine
   write-in), raced against the tool's deadline; without one, when Clef
   fails, or when it answers late, only an option number or the exact option
   text counts and anything else is `unclear`.
8. **Files** come from the turn's `ctx.session.channel.attachments` (the
   runtime release that carries WhatsApp files), each checked (https link,
   sha256, size), matched against the question's `acceptedTypes`; a file
   already in the draft (same sha256) answers `duplicate`.
9. **Sending**, only with `confirmed: true` (see above). An application goes out as the application card
   (`ixo.bid.submit.v1`), logged work as the claim card
   (`ixo.claim.submit.v1`) — `@ixo/action-protocol` 0.7.0, Hub protocol
   level 5. The plugin first reads `ctx.hubActions.capabilities()`: when the
   Hub does not offer that kind to the account it answers `not_enabled`, not
   retryable ("Sending … from chat isn't switched on for this number yet;
   everything is saved."). The claim card carries the answers without file
   questions (`data`, at most 60,000 characters), the summary rows, and one
   `evidence` entry per file still answering a visible question (`field` as
   a dotted path, `shops[2].photo` → `shops.2.photo`; the gateway link,
   filename, type, size and SHA-256; at most 30). A draft that does not fit
   answers `too_large`, not retryable. On approval the Hub uploads the files
   to the collection's claims lane as the person, signs the answers, saves the
   claim to the claims bot and submits it on chain, in one approval.
   The request key hashes the draft's last change and its `cardAttempt`: the
   same answers never make two cards, and a card that was declined, expired,
   cancelled or failed — or got no outcome by its expiry (plus 60 s) — is
   cleared and `cardAttempt` bumped, so it can be sent again in a new run.
   A failed card's receipt (`ixo.submission.failed.v1`) is kept on the draft
   as `lastCard` (`stoppedAt`, `hubSaid`) until the next card is sent; a
   submitted claim keeps its `claimId` from `ixo.claim.submission.v1`.
   Answers are locked while a card waits.

10. **Instant permission (optional).** A host may pass
    `instantPermission: { allows(collectionId), grant({ collectionId, admin,
address, signal }) }`. For a collection it `allows`, `submit` of a
    finished application sends no card: it calls `grant` (a failure answers
    `unavailable`, retryable, and the application stays open; the turn's abort
    is rethrown), marks the application done, reads the permission on chain
    again and answers `can_log_work` ("it can take a few seconds to show"
    when the grant is not visible yet). A claim on such a collection without
    permission answers `apply_first` instead of `not_accepted`. Without the
    hook, or when `allows` is false, every job waits for the operator to
    accept the application. The plugin holds no wallet: the host decides
    which collections and grants with its own key.

## Known limits

- **Lockfile.** `@ixo/action-protocol` is pinned to 0.7.0, which is not on
  npm yet: `pnpm-lock.yaml` must be regenerated once it is published.
- **Mainnet only for programmes**: the Jambo worker has no testnet or devnet
  list.
- **Pay** reads as an amount only for USDC (`ibc/6BBE…F97B`, "$1.27") and
  IXO; any other reward reads as "a reward".
- **Names of logged work** come from each collection's claim form; a form
  that cannot be read shows "Opportunity <id>".
