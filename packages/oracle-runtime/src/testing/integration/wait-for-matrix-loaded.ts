import { type IntegrationOracle } from './harness.js';

/**
 * Block until the booted oracle reports `matrix:loaded`. Many downstream
 * code paths depend on the Matrix-side signing identity (loaded after init
 * completes):
 *
 *   - `UcanService.mintInvocation` returns null until the signing mnemonic
 *     is wired, so plugin Tier-A direct invocations fail.
 *   - `SubscriptionMiddleware` rejects authenticated requests with
 *     "UCAN signing key not configured" before the key lands.
 *   - `RequestPreparer` resolves the user's encrypted Matrix room id from
 *     the Matrix client when the session row doesn't carry one, which
 *     requires Matrix to be initialized.
 *
 * Throws when `matrix:failed` is emitted (boot is broken — fail loudly,
 * not after 60s of polling) or when the deadline elapses.
 */
export async function waitForMatrixLoaded(
  oracle: IntegrationOracle,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loaded = oracle.events.statusChanges.find(
      (e) => e.plugin === 'matrix' && e.to === 'loaded',
    );
    if (loaded) return;
    const failed = oracle.events.statusChanges.find(
      (e) => e.plugin === 'matrix' && e.to === 'failed',
    );
    if (failed) {
      throw new Error(
        `Matrix init failed during boot: ${failed.reason ?? 'no reason given'}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Matrix did not reach 'loaded' within ${timeoutMs}ms — last events: ` +
      JSON.stringify(oracle.events.statusChanges.slice(-5)),
  );
}
