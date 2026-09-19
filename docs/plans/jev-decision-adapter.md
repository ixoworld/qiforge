# PR 2 — Jev DecisionAdapter

Status: design ready for implementation.

Depends on PR #309: bounded semantic Decision primitive.

## Objective

Add the first production DecisionAdapter for QiForge using TypeSafe Jev through Cloudflare AI.

This PR does not change commerce routing behavior. It supplies the provider adapter and configuration only. Commerce shadow mode remains PR 3.

## External contract

Cloudflare currently exposes Jev as typesafe/jev. The model accepts state plus typed Noul, Choice, and Score questions.

QiForge maps them as follows:

| QiForge | Jev | Normalized result |
| --- | --- | --- |
| boolean | Noul | probabilityTrue |
| choice | Choice | value, confidence, probabilities |
| ordinal | Score | score, confidence, probabilities |

Jev Score is continuous. A three-level rubric can return 1.84, not only integer indices. PR #309 therefore uses a bounded continuous ordinal score in the range 0..N-1.

## Transport

Node adapter:

~~~text
POST https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run
Authorization: Bearer {apiToken}
Content-Type: application/json
cf-aig-gateway-id: {gatewayId}   # optional

{
  "model": "typesafe/jev",
  "input": {
    "state": ...,
    "questions": ...
  }
}
~~~

Cloudflare's REST API normally returns its standard success/result envelope. The Jev model documentation also shows the model result directly. The parser should accept both forms.

Node 22 built-in fetch is sufficient; no provider SDK is required.

## Proposed files

~~~text
packages/oracle-runtime/src/decisions/
├── adapters/
│   ├── cloudflare-jev.ts
│   ├── cloudflare-jev.test.ts
│   └── index.ts
├── config.ts
├── config.test.ts
└── index.ts
~~~

No Jev-specific types move into @ixo/common. The common package remains provider-neutral.

## Adapter API

~~~ts
export interface CloudflareJevAdapterOptions {
  accountId: string;
  apiToken: string;
  gatewayId?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class CloudflareJevDecisionAdapter implements DecisionAdapter {
  readonly provider = 'cloudflare';
  readonly model = 'typesafe/jev';

  constructor(options: CloudflareJevAdapterOptions);

  evaluate(
    request: DecisionRequest,
    options?: DecisionProviderOptions,
  ): Promise<DecisionProviderResult>;
}
~~~

The adapter only translates, calls the provider, and normalizes results. It never applies thresholds or business policy.

## Configuration

Add optional core environment fields:

~~~text
DECISION_PROVIDER=cloudflare-jev
CLOUDFLARE_ACCOUNT_ID=<account id>
CLOUDFLARE_API_TOKEN=<Workers AI token>
CLOUDFLARE_AI_GATEWAY_ID=<optional named gateway>
~~~

Rules:

1. An explicit createOracleApp({ decisionAdapter }) wins.
2. If DECISION_PROVIDER is unset, behavior stays exactly as PR #309: Decisions register but evaluation throws DecisionProviderUnavailableError.
3. If DECISION_PROVIDER=cloudflare-jev, account ID and API token are mandatory; missing values fail boot with named configuration errors.
4. CLOUDFLARE_AI_GATEWAY_ID is optional. When present it is sent as cf-aig-gateway-id.
5. Thresholds are not provider configuration; they belong to consuming policy.

Add:

~~~ts
createDecisionAdapterFromConfig(config): DecisionAdapter | undefined
~~~

createOracleApp resolves:

~~~ts
const decisionAdapter =
  opts.decisionAdapter ?? createDecisionAdapterFromConfig(validated.config);
~~~

## Provider mapping

Boolean:

~~~text
QiForge kind=boolean
→ Jev type=noul
→ response.noul
→ probabilityTrue
~~~

Choice:

~~~text
QiForge kind=choice, options
→ Jev type=choice, criteria=options
→ choice, confidence, probabilities
→ value, confidence, probabilities
~~~

Ordinal:

~~~text
QiForge kind=ordinal, levels
→ Jev type=score, criteria=levels
→ score, confidence, probabilities
→ score, confidence, probabilities
~~~

Usage maps input_tokens/output_tokens to inputTokens/outputTokens. Jev's returned model version is preserved as modelVersion while the adapter's stable model identifier remains typesafe/jev.

## Error semantics

Define CloudflareJevDecisionError with safe metadata only, such as HTTP status and provider error code.

It must never include or log:

- projected Decision state;
- Authorization headers or API tokens;
- full request bodies;
- provider response bodies that could echo user state.

Expected behavior:

| Condition | Result |
| --- | --- |
| network failure | throw provider error |
| abort signal | propagate abort |
| non-2xx HTTP | throw provider error |
| Cloudflare success=false | throw provider error |
| missing answers | throw provider error |
| unknown Jev answer type | throw provider error |
| malformed probabilities | core Decision validation rejects |
| timeout | DecisionRuntime aborts and throws timeout |

No automatic retry in PR 2. Repeated semantic evaluations can differ, and retries would obscure the latency and failure characteristics needed for calibration.

## Response parser

Expected Jev result:

~~~ts
{
  model?: string,
  answers: Record<string,
    | { type: 'noul', noul: number }
    | {
        type: 'choice',
        choice: string,
        confidence: number,
        probabilities: Record<string, number>
      }
    | {
        type: 'score',
        score: number,
        confidence: number,
        legend?: Record<string, string>,
        probabilities?: Record<string, number>
      }
  >,
  usage?: {
    input_tokens?: number,
    output_tokens?: number
  }
}
~~~

The adapter returns only the normalized DecisionProviderResult. The existing DecisionRuntime remains responsible for provider-independent bounds and answer-space validation.

## Required tests

1. Boolean to Noul request mapping.
2. Choice to Choice request mapping.
3. Ordinal to Score request mapping.
4. Direct Jev result parsing.
5. Cloudflare envelope parsing.
6. Noul probability mapping.
7. Choice value/confidence/probability preservation.
8. Fractional Score preservation.
9. Usage mapping.
10. Provider model to modelVersion.
11. AbortSignal forwarded to fetch.
12. Optional AI Gateway header.
13. Non-2xx failure contains no Decision state.
14. success=false failure contains no Decision state.
15. Unknown answer type rejected.
16. Provider unset means no adapter.
17. Selected provider with missing credentials means boot validation error.
18. Configured provider creates an adapter.
19. Explicit host decisionAdapter remains authoritative.

## Non-goals

PR 2 does not:

- register a commerce Decision;
- replace the Matrix LLM classifier;
- introduce decision thresholds;
- add shadow telemetry;
- expose Decisions as agent tools;
- implement Workers-runtime parity;
- add MCDA integration.

## Follow-up

~~~text
PR #309  bounded Decision primitive
    ↓
PR 2    Cloudflare Jev DecisionAdapter
    ↓
PR 3    oracle-payments.route-message + shadow mode
    ↓
          calibration
    ↓
PR 4    Decision-based commerce routing
    ↓
PR 5    Workers runtime parity
~~~

## Acceptance criteria

PR 2 is complete when:

- a registered Decision can execute against real Jev through ctx.decisions.evaluate without plugin code knowing Cloudflare or Jev syntax;
- all three QiForge question kinds round-trip correctly;
- no action or authority semantics enter the adapter;
- missing provider configuration fails at boot only when that provider is explicitly selected;
- deployments with no Decision provider behave exactly as before;
- CI build, lint, format check, and adapter tests pass.
