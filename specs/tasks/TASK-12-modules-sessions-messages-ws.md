# TASK-12: Sessions, Messages, WS modules relocate

**Phase:** 3 — Tier-0 module relocation
**Spec:** §22.10
**Effort:** 2 days
**Depends on:** TASK-05
**Blocks:** TASK-11
**Parallel with:** TASK-13, TASK-14

## Goal

Move three NestJS modules into the runtime package: Sessions, Messages, WebSocket Gateway. **No logic changes** — `git mv` preserves history. The runtime imports these directly into `RuntimeAppModule`.

## Deliverables

### Moved (`git mv`)

- `apps/app/src/sessions/` → `packages/oracle-runtime/src/modules/sessions/`
- `apps/app/src/messages/` → `packages/oracle-runtime/src/modules/messages/`
- `apps/app/src/ws/` → `packages/oracle-runtime/src/modules/ws/`

### Modified (after move)

- Update relative imports inside each moved file. Imports of singletons (`MatrixManager`, `SecretsService`, etc.) continue to work because those packages don't move.
- Wire each module into `packages/oracle-runtime/src/bootstrap/runtime-app-module.ts` as a static import.
- Existing tests within these directories must still pass.

## Acceptance

- [ ] `git log --follow packages/oracle-runtime/src/modules/sessions/sessions.service.ts` shows pre-move history.
- [ ] All three modules importable from runtime.
- [ ] `RuntimeAppModule` imports `SessionsModule`, `MessagesModule`, `WsModule`.
- [ ] Existing spec files (`sessions.service.spec.ts`, `messages.service.spec.ts`, `ws.gateway.spec.ts`, `ws.service.spec.ts`) pass after the move.
- [ ] No behavior change: SSE response shape, WebSocket events, session creation flow all identical.

## Out of scope

- Refactoring any logic inside these modules. Pure relocation.
- Bridging WebSocket emissions to plugin `ctx.emit` — that's done in TASK-05's `scoped-emitter.ts`.
- Subscription middleware (TASK-14).

## Notes

- §22.10 lists all Tier-0 modules. Three of them are in this task; six others are in TASK-13 and TASK-14.
- The WS gateway holds the Socket.IO server reference that the scoped emitter needs (per TASK-05). After the move, TASK-05's `events/scoped-emitter.ts` references `WsGateway` cleanly via DI rather than via a global.
- Today's `messages.service.ts` uses both SSE and WS for streaming — that all stays.
