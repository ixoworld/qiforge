# Native IXO tools

Install `IxoToolsPlugin` to let a QiForge agent read IXO account, credits, product concepts, files, memory and off-ramp information through the shared tool contracts.

The plugin is opt-in and on demand. It is not in `BUNDLED_WORKERS_PLUGINS`. This stage does not install the plugin in Companion or expose an inbound MCP endpoint.

```ts
import {
  BUNDLED_WORKERS_PLUGINS,
  createOracleWorker,
  IxoToolsPlugin,
} from '@ixo/oracle-runtime-workers';

const oracle = createOracleWorker({
  config: { name: 'My oracle' },
  plugins: [...BUNDLED_WORKERS_PLUGINS, new IxoToolsPlugin()],
});

export const { UserOracleDO, MatrixGatewayDO } = oracle;
export default oracle;
```

`IxoToolsPlugin` is also exported from `@ixo/oracle-runtime-workers/ixo-tools`. Existing Worker migration and Matrix configuration requirements still apply. Adding the plugin does not grant a user permission to call it.

## Configuration

Supply the actual service origins for the deployment's validated `NETWORK`. Each value must be an HTTPS origin without a path, credentials, query or fragment. There are no default service addresses.

| Binding                          | Purpose                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `IXO_TOOLS_SUBSCRIPTIONS_ORIGIN` | Verified account and representation-two credits service.                                         |
| `IXO_TOOLS_MEMORY_ORIGIN`        | Scoped agent search and current-reference checks.                                                |
| `IXO_TOOLS_VFS_ORIGIN`           | Authorized metadata observations and revision checks.                                            |
| `IXO_TOOLS_YELLOWCARD_ORIGIN`    | Narrow agent reads and restricted estimates.                                                     |
| `IXO_TOOLS_UCAN_STORE_ORIGIN`    | Fresh independent VFS delegation lookup.                                                         |
| `IXO_TOOLS_MODULES`              | Comma-separated catalog tool names. Omit to include all ten. An empty string disables all ten.   |
| `IXO_TOOLS_ORACLE_KNOWLEDGE`     | `public` by default, or `private` with the required source authority and private reply audience. |

Module selection only removes tools. It never creates a grant. Service contracts from the preceding stage must be available before enabling the integration. An open source PR does not establish a deployed service contract.

## Authorization and disclosure

Each native tool requires an exact capability on `ixo:agent-tools`. The action is `agent-tools/` followed by its catalog name, for example `agent-tools/ixo_credits_get`. Wildcards and downstream service rights do not substitute for native consent. The relevant independent service right is still required to retrieve private source data.

The user Durable Object constructs one host for the admitted turn. It binds the authenticated owner, deployment oracle DID, network, session, reply room, disclosure visibility and timezone. A tool argument, browser declaration or checkpoint cannot replace those facts. The model receives neither a raw service client nor a credential.

Current authority checks verify the delegation and its owner, audience and finite expiry. They repeat before and after source retrieval and before returning the result. Revocation and replacement during an asynchronous check suppress the result. Source credentials are fresh, narrowly scoped and audience-specific.

Private disclosure requires checking every reply destination. Portal turns mirrored into Matrix require a verified DID-to-Matrix binding and fresh participant evidence for exactly the owner and the oracle. Matrix turns require the same participant proof. A Portal stream that is not mirrored has a private audience. Conversation labels such as `direct`, room aliases and group-routing settings are not privacy evidence. An unknown or shared audience suppresses private data. Other transports remain shared until they have a reviewed disclosure rule.

The gateway must already have its plugin-device credentials from the existing host setup. The participant reader uses those credentials passively. It does not start the bot, log in or join rooms. Without credentials, private Matrix and mirrored Portal tools remain unavailable.

Revocation records an explicit marker before the first asynchronous step. Hydration honors the marker in memory and in durable storage. A stale stored or room-state delegation cannot automatically restore access. An explicit new authenticated authorization can replace the marker. If durable persistence fails, `DELETE /delegation` returns HTTP 503. The live object remains revoked, but a failed durable write does not establish revocation after a cold restart.

The agent loads `ixo-tools` through the normal capability loop. Loading changes discovery, not authority. Protected names remain reserved while disabled or unauthorized. Live availability checks remove revoked tools from listing, loading and model calls. A newly granted tool that was absent when the graph was built becomes available on the next turn.

## Tool contracts

| Tool                         | Source and meaning                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `ixo_account_get`            | Verified root DID account on the selected network.                                      |
| `ixo_credits_get`            | Exact integer `upay` base units. Divide by 1000 for displayed credits.                  |
| `ixo_concept_get`            | Reviewed, versioned canonical Topic explanation.                                        |
| `ixo_error_explain`          | Supplied error text or an authorized owned error receipt.                               |
| `ixo_files_find`             | Authorized VFS metadata and current-session attachment receipts with explicit coverage. |
| `ixo_operation_get`          | Safe owned operation status.                                                            |
| `ixo_offramp_options`        | Current corridor guidance. Unknown eligibility remains unknown.                         |
| `ixo_offramp_quote`          | Expiring USDC estimate. It does not lock settlement or initiate payment.                |
| `ixo_memory_personal_search` | Explicit user-plus-oracle personal memory.                                              |
| `ixo_memory_oracle_search`   | Explicit knowledge from the active oracle with permitted visibility.                    |

Every tool uses a strict schema generated from the same catalog. Conversion failure stops native schema initialization. Extra authority fields and mixed error selectors are rejected. Results preserve available, unauthorized and unavailable outcomes with source evidence. An outage does not establish zero credits, an absent upload or a completed operation.

Use live services for balances, accounts, permissions and operation status. Use canonical knowledge for product definitions, personal memory for the user's history and preferences, and oracle memory for permitted domain procedures. When both memory scopes are useful, query them separately. File discovery distinguishes metadata, content indexing and current-session receipts. A receipt time is not the original media upload time.

## Verification and rollout

The local verification runs the actual Workers list, load and invocation loop with scripted model calls and controlled source protocol responses. This verifies runtime behavior, not model intent selection or hosted acceptance. Run `pnpm --filter @ixo/oracle-runtime-workers test:native-package` after building the workspace. The installed-package guard packs local dependencies, installs them into a clean consumer, checks the public imports and runs the native adapter in workerd.

The clean consumer pins `matrix-js-sdk` to `42.2.0` across dependencies and peers, matching the Workers dependency environment in the repository lockfile. Unconstrained npm resolution currently produces an incompatible `MatrixClient` type in the existing editor integration. Pinning only the bot SDK dependency does not constrain the CRDT peer. The guard records the consumer-wide pin. [ORA-844](https://linear.app/ixo-world/issue/ORA-844) tracks that compatibility gap. A release must resolve the gap or retain a reviewed consumer pin.

Hosted two-user, two-network and two-oracle acceptance, actual-model scenarios, Companion installation, skill publication, MCP conformance and release remain separate gates in [ORA-843](https://linear.app/ixo-world/issue/ORA-843). Keep the preceding package and source revisions pinned through those gates. No payment execution is exposed by this plugin.
