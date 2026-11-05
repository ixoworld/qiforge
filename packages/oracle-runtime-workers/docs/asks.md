# asks.world (asks plugin)

The `asks` plugin (`src/plugins/asks/`) connects an oracle to asks.world
through asks' hosted MCP connector. Each person signs in once with OAuth
(asks' Google login). After that the oracle can find paid work for them,
post asks that real people answer, get an app or agent reviewed by verified
pros, and show or cash out their asks money. Nothing that moves money happens
in the chat: those tools return a link, and the person taps the button on
asks.world. The plugin came from IXO Companion, where it was first built.

It is in `BUNDLED_WORKERS_PLUGINS` and stays off unless its env is set. An
oracle turns it on with one secret, the Durable Object steps and an allowlist
entry on asks' side ([Turning it on](#turning-it-on)).

## What it adds

- The connector's own tools (`asks__…`), passed through as asks describes
  them. They are read again every 5 minutes. A tool whose input schema can't
  be bound is left out and logged, so it never fails the turn: `propertyNames`
  is stripped first, and LangChain's `toJsonSchema` makes the final check.
- `asks_connect`, `asks_status` and `asks_disconnect` for the sign-in.
- `asks_skill`: the asks skills, read live from `ixoworld/ixo-plugins`
  (`plugins/asks/skills` on mainnet, `plugins/asks-testnet/skills` on testnet
  and devnet). They are cached for an hour and fall back to a bundled copy. At
  most 30 skills are read, each cut at 16,000 characters.
- A skill pick: once the plugin is loaded for a thread, a bounded Decision
  (`asks.pick-skill`, 2 s timeout) chooses the skill the message needs and
  puts it into the prompt before the first model call. Any error, a timeout
  or a low-confidence answer picks nothing, and the model can still call
  `asks_skill`.
- `asks_attach_files`: sends the files from this turn's channel message
  (photos, PDFs) with a `submit_work` draft.

The manifest is `on-demand`, with a `brief` for the capability catalogue.

## Safety behaviour

- The asks account that finishes a sign-in must be the oracle user's own
  DID (`did:ixo:<address>`). If it isn't, the tokens are revoked and nothing
  is stored.
- Token refresh is serialized and single-flight per person. A 4xx from the
  token endpoint (except 408 and 429) ends the connection. A 401 from the
  connector is checked against asks before the connection is dropped.
- An upload address is kept only when it comes from `submit_work`'s own
  answer and sits on an asks host: the connector's host for `NETWORK`, or a
  host under its domain (`api.asks.world`, `test.api.asks.world`). Board text
  can carry a look-alike. The signed PUT goes only to
  `*.r2.cloudflarestorage.com`, at most 5 MB per file.
- `ASKS_ALLOWED_DIDS` limits the plugin to a pilot list of users.

## Environment

| Variable                   | Meaning                                                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASKS_TOKEN_KEY`           | Secret, required. At least 32 characters (`openssl rand -base64 32`). Use one per network. It seals each person's tokens (AES-GCM) and names their connection object (HMAC of the DID). Changing it disconnects everyone. Without it, the plugin is off.         |
| `ORACLE_PUBLIC_URL`        | Required (core variable). The oracle's public origin: the sign-in callback is `<ORACLE_PUBLIC_URL>/asks/oauth/callback`.                                                                                                                                         |
| `NETWORK`                  | Required (core variable). Picks the connector: mainnet `https://asks.world/v1/mcp`, testnet `https://test.asks.world/v1/mcp`, devnet `https://dev.asks.world/v1/mcp`. If it is missing or not one of these, the plugin stays off and logs why. It never guesses. |
| `ASKS_WHATSAPP_RETURN_URL` | Optional. A `https://wa.me/<number>?text=…` link. After a sign-in started from WhatsApp, the callback page shows "Back to WhatsApp" with this link.                                                                                                              |
| `ASKS_ALLOWED_DIDS`        | Optional. Comma- or space-separated user DIDs who get the plugin. If unset, every user does.                                                                                                                                                                     |
| `ORACLE_NAME`              | Core variable. The `client_name` asks shows beside the oracle's host when a person signs in.                                                                                                                                                                     |

There is no connector URL setting. The URL comes from `NETWORK`.

## Routes

These are served by the shell without UCAN auth (`GET` only):

- `/asks/oauth/client.json`: the OAuth Client ID Metadata Document, as
  `application/json`. `client_id` is `<ORACLE_PUBLIC_URL>/asks/oauth/client.json`
  and `redirect_uris` is `["<ORACLE_PUBLIC_URL>/asks/oauth/callback"]`. It
  answers 404 when the plugin's env is incomplete.
- `/asks/oauth/start/:state`: the short link sent in the chat. It redirects
  (302) to asks' authorize page.
- `/asks/oauth/callback`: asks sends the browser back here.

## What the host adds

The plugin keeps each person's sign-in in its own Durable Object,
`AsksConnectionDO`. It is reached both from the user's object (the tools)
and from the shell (the routes). The package exports the class, and the
oracle script declares it:

```ts
// src/index.ts of the oracle script
export { AsksConnectionDO } from '@ixo/oracle-runtime-workers';
```

```jsonc
// wrangler.<env>.jsonc of the oracle script
"durable_objects": {
  "bindings": [
    { "name": "ASKS_CONNECTIONS", "class_name": "AsksConnectionDO" }
  ]
},
"migrations": [
  { "tag": "<next tag>", "new_sqlite_classes": ["AsksConnectionDO"] }
]
```

Keep the class name `AsksConnectionDO`. A deployment that already has the
namespace under that name (IXO Companion) keeps its stored sign-ins and adds
no new migration. Without the binding, the plugin logs
`the ASKS_CONNECTIONS binding is missing` and offers no tools.

By default the plugin reads the binding through `env` from
`cloudflare:workers`. A host can pass its own: `new AsksPlugin({ env: () => env })`.

## The asks side

asks.world accepts a sign-in return only from assistant hosts on its
allowlist for that network: `CONNECTOR_ORACLE_HOSTS` on the asks deployment.
IXO Companion is allowed by default. asks also fetches
`/asks/oauth/client.json` from the oracle, so that route must be publicly
reachable.

## Turning it on

1. Set `ASKS_TOKEN_KEY` on the oracle script (`wrangler secret put`). Check
   that `ORACLE_PUBLIC_URL` and `NETWORK` are set.
2. Add the `ASKS_CONNECTIONS` binding, the migration and the class re-export
   ([What the host adds](#what-the-host-adds)).
3. Ask the asks team to add the oracle's host (for example `yoma.ixo.earth`)
   to `CONNECTOR_ORACLE_HOSTS` for that network.
