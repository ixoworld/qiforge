# @ixo/agent-tools-sources

Source adapters connect the ten IXO read tools to Subscriptions, canonical docs, VFS, current-session attachments, Memory Engine and YellowCard. The package uses Web APIs and works in Workers without Node compatibility. Its only runtime export is `createIXOSourceAdapters`. Deep imports are unsupported.

```ts
import { createAgentToolsHost } from '@ixo/agent-tools';
import { createIXOSourceAdapters } from '@ixo/agent-tools-sources';

const sources = createIXOSourceAdapters({
  network: 'devnet',
  origins: deploymentOrigins,
  authority: trustedSourceAuthority,
  attachments: currentSessionAttachments,
});
const host = createAgentToolsHost({ ...sources, readGrants });
const token = host.bindContext(verifiedHostFacts);
await host.invoke(token, 'ixo_credits_get', {});
```

The trusted host supplies deployment origins, identity, grants and the attachment accessor. Model arguments cannot select them. Every authenticated request first checks the fixed origin's DID document against its host-derived `did:web`. It then asks the appropriate source-specific authority method for a fresh invocation. Redirects are refused. Bodies, timeouts, scans and result counts are bounded. The package never forwards an ingress bearer or uses a service API key.

`SourceAuthority` has four methods. `subscriptions(context)` mints `subscriptions/read` on `ixo:subscriptions`. `vfs(context, action)` obtains a user-owned VFS delegation and mints exactly `fs/list` or `fs/read`. `memory(context)` mints `memory/search` on `ixo:memory`. `yellowcard(context, action)` mints exactly `yellowcard/agent-read` or `yellowcard/agent-quote` on `ixo:yellowcard`. The implementation must bind each method to the same configured audience that the adapter checks. Missing authority returns null. Other mint or transport failures make the source unavailable. These are trusted host ports, never tools for an LLM.

The factory returns `adapters` and `resourceAccess` for the pure host. Current resource checks issue fresh source requests. They do not cache an authorization verdict across invocations. The host still checks grants before and after retrieval and immediately before disclosure.

## Source contracts

| Source        | Read contract                                                                                        | Evidence limit                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Subscriptions | `/api/v1/subscriptions/account?network=...` and `/api/v1/subscriptions?representation=2&network=...` | Verified root address, selected network and exact `upay` base units. `1234` displays as 1.234 credits. Digests identify service observations, not chain height or finality.                |
| Docs          | Fixed `/articles/topics.md`                                                                          | Only Topic is enabled. Bytes must match the reviewed generated Markdown digest `2eed6d29d09002930b46f4d473c362a9cf86daeb14f44ba7ed7bb9ec2ab2b77d`.                                         |
| VFS           | `/api/fs/observations` and `/api/fs/observations/check`                                              | Personal root namespace only. At most 100 heads from one bounded source snapshot. Exact version bytes and hashes verify text matches. Ten content reads and 1 MB per file bound each scan. |
| Attachments   | Host-owned `SessionAttachments`                                                                      | Current user and session only. Trusted receipt time and immutable metadata revision are required. This does not search the user's other sessions or Matrix media history.                  |
| Memory        | `/agent/search` and `/agent/references/check`                                                        | Separate personal and oracle scopes. Content revisions are checked before disclosure. A bounded empty search is not proof of complete knowledge.                                           |
| YellowCard    | `/agent/options`, `/agent/quote`, `/agent/operations/:id`, `/agent/errors/:id`                       | Owned safe projections and exact, expiring estimates. New capabilities cannot execute payments.                                                                                            |

`oracleKnowledge` defaults to `public`. A trusted private host may explicitly select `private`; shared context always requests public knowledge. The engine independently checks transport policy and current private-domain membership. Retrieved text cannot grant authority or prove an account balance.

File `uploadedAt` means source registration. `timeBasis: vfs_created` identifies the VFS row's creation time. `session_received` identifies when QiForge accepted that attachment message. Neither proves the original media upload time. Yesterday uses the host's IANA calendar date, including daylight saving transitions. A missing source, legacy receipt, unindexed binary, incomplete inventory, content-read failure or scan budget prevents an absence claim. Attachments with content that has not been searched remain partial even when their metadata inventory is complete.

YellowCard eligibility describes the corridor, never user KYC approval. Quote descriptions identify an estimate with an expiry, not a settlement-locked price. Continue at Portal `/workspace/portfolio/offramp/yellowcard` for the human bank withdrawal flow. No prefill or execution is implied. Supplied error text uses the package's reviewed safe dictionary; unknown text stays unexplained rather than becoming a repair command.

## Verification and rollout

`pnpm --filter @ixo/agent-tools-sources test` exercises all ten bindings and denial, outage, owner/network, source revision, stale/expired evidence, indexing, session and DST cases. Its transport fixtures test adapter behavior. Separate source repositories test their actual handlers and UCAN middleware. `test:package` packs both libraries, installs them into an isolated consumer, rejects private imports and invokes the installed source factory in workerd without Node compatibility.

Catalog 2.0.0 tightens credits to integer base units and requires file timestamp provenance. Source-envelope version remains 1. The library does not install a native plugin, Companion tool set or MCP ingress. Those rollout stages must use the same host and adapters rather than recreating identity policy.

Local tests do not establish hosted acceptance. Deployments need the pinned Subscriptions representation, reviewed docs bytes, new VFS and memory routes, and YellowCard routes and quote migration before enabling the corresponding tools. Signed-in two-user acceptance, deployed revisions and model intent evaluations remain separate gates. No deployment is part of this change.
