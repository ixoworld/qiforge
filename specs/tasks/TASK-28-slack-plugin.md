# TASK-28: Convert `slackPlugin`

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 2.5 days
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the Slack transport into a plugin. Auto-detected via `SLACK_BOT_OAUTH_TOKEN`. Has socket connection lifecycle (OnModuleInit/OnModuleDestroy in today's NestJS module). `visibility: 'on-demand'`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/slack/slack.plugin.ts` — class with `configSchema` (5 SLACK_* env vars per §17.2), manifest (`visibility: 'on-demand'`, category `'communication'`), `getTools(ctx)` returns slack-specific tools (e.g. `slack_send_message`).
- `packages/oracle-runtime/src/plugins/slack/index.ts`
- `packages/oracle-runtime/src/plugins/slack/slack.plugin.test.ts`

### Moved (`git mv`)

- `apps/app/src/slack/` → `packages/oracle-runtime/src/plugins/slack/service/`. Includes `SlackService` (with `OnModuleInit`/`OnModuleDestroy` lifecycle), `slack.module.ts`, `slack.service.spec.ts`.
- `packages/slack/` (the existing standalone package) — leave it alone if it's a separate consumable; otherwise relocate.

### Modified

- The plugin's class wraps the existing `SlackModule` so it's registered in `RuntimeAppModule` only when `features.slack` is true.
- The Slack formatting prompt section (today: `slackFormatting` flag in main-agent's prompt) — handled by the plugin via its `getMiddlewares()` adding a middleware that branches on `requestCtx.session.client === 'slack'`.

## Acceptance

- [ ] Plugin loads with `SLACK_BOT_OAUTH_TOKEN` set.
- [ ] `OnModuleInit` socket connection works.
- [ ] `OnModuleDestroy` cleanly shuts down the socket.
- [ ] Slack formatting branching in prompt works as today.
- [ ] Test: existing `slack.service.spec.ts` passes after relocation.

## Out of scope

- New Slack features.
- The `@ixo/slack` standalone package — leave that as-is unless it duplicates code.

## Notes

- Lifecycle is critical: SlackService manages a long-lived socket. OnModuleInit/OnModuleDestroy hooks per existing pattern.
- §16.1 catalog: `failureMode: 'disable'` in v2 spec — in v3 there's no `failureMode`, so if Slack init fails, the runtime logs and skips per default Promise.allSettled-like behavior.
