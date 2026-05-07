# TASK-29: Convert `creditsPlugin`

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 2 days
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-30 (claim-processing depends on credits), TASK-32
**Parallel with:** other plugin conversion tasks (except TASK-30)

## Goal

Convert the credits feature (subscription enforcement + token-limiter middleware) into a plugin. ON unless `DISABLE_CREDITS=true`. `visibility: 'silent'` — no agent-visible tools.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/credits/credits.plugin.ts` — class with `configSchema: { DISABLE_CREDITS, SUBSCRIPTION_URL, SUBSCRIPTION_ORACLE_MCP_URL }`. Manifest `visibility: 'silent'`. `getMiddlewares()` returns the token-limiter middleware (today's `apps/app/src/graph/middlewares/token-limiter-middelware.ts`).
- `packages/oracle-runtime/src/plugins/credits/index.ts`
- `packages/oracle-runtime/src/plugins/credits/credits.plugin.test.ts`

### Moved (`git mv`)

- `apps/app/src/graph/middlewares/token-limiter-middelware.ts` → `packages/oracle-runtime/src/plugins/credits/token-limiter-middleware.ts`. (Note: current filename has a typo `middelware`; fix to `middleware`.)
- (The subscription middleware itself — `apps/app/src/middleware/subscription.middleware.ts` — is a Tier-0 module per TASK-14, NOT this plugin. Credits plugin only owns the token-limiter middleware that runs inside the graph; subscription middleware runs at HTTP level before the graph.)

### Modified

- Conditional load: today's `if (!DISABLE_CREDITS && isRedisEnabled()) addMiddleware(tokenLimiterMiddleware)` per `main-agent.ts:960-968` — this becomes the plugin's `getMiddlewares()` returning empty when `ctx.config.DISABLE_CREDITS === true` or `tasksPlugin` (Redis) isn't loaded.

## Acceptance

- [ ] Plugin loads when `DISABLE_CREDITS !== true`.
- [ ] Token-limiter middleware runs on every graph invocation when both `credits` and Redis (via tasks plugin) are available.
- [ ] When `DISABLE_CREDITS=true`, plugin is excluded; cascade: `claim-processing` plugin (TASK-30) also excluded.
- [ ] No agent-visible tools (silent).
- [ ] Test: middleware blocks request when token balance reaches zero.

## Out of scope

- The HTTP-level subscription middleware — TASK-14 owns that.
- Claim processing — TASK-30.

## Notes

- §16.1: `credits` is `failureMode: 'fatal' (prod) / 'degrade' (dev)` in v2 — v3 dropped failureMode. If env vars missing in production, boot fails via `composeEnvSchema` from TASK-04.
- The naming inconsistency in today's file (`token-limiter-middelware.ts` typo) is a good chance to fix.
