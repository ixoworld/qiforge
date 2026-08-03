/**
 * @fileoverview Process-wide access to the decision ledger, for runtime code
 * that cannot be handed it.
 *
 * Most of the runtime reaches the ledger through `AmbientServices`, which is
 * captured at boot and never shown to plugin authors. One place cannot: tools
 * built inside a plugin's `getRequestTools` see only `RuntimeContext`, which
 * *is* the plugin-facing type. Putting the ledger there would hand every
 * plugin — including a fork's own — the ability to write entries into the
 * entity's audit chain, and a chain anyone can append to proves nothing about
 * what the entity decided.
 *
 * So the ledger is reachable here instead, on the same terms as
 * `MatrixManager.getInstance()` and `SecretsService.getInstance()`: internal
 * to the runtime, not exported from the package's public surface.
 *
 * Returns undefined before boot has bound one, which the gate reads as "no
 * recorder wired" rather than "recording failed" — the two mean different
 * things, and only the second is a refusal.
 */
import type { DecisionRecorder } from '../../graph/middlewares/constitution-gate-middleware.js';

let current: DecisionRecorder | undefined;

/** Binds the ledger for this process. Called once, from the module factory. */
export function setCurrentDecisionLedger(ledger: DecisionRecorder): void {
  current = ledger;
}

/** The ledger this process records to, or undefined before boot binds one. */
export function getCurrentDecisionLedger(): DecisionRecorder | undefined {
  return current;
}

/** Clears the binding. Exists so a test suite does not leak one into the next. */
export function resetCurrentDecisionLedger(): void {
  current = undefined;
}
