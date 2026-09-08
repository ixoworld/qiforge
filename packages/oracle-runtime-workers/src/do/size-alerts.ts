/**
 * Storage watermark alerts: a Slack webhook message the first time a user's
 * working-copy SQLite file crosses each whole-GB threshold from
 * `START_ALERT_GB` up (1 GB, then 2 GB, ... 9 GB is the last crossing below
 * the cap). One alert per threshold — the caller persists the highest GB
 * already alerted and passes it back in.
 *
 * Exists for two reasons: the DO storage cap is 10 GB per user object, and
 * resident storage is the runtime's dominant cost ($0.20/GB-month) — see the
 * cost-planning notes in the package README. Early crossings are the signal
 * to schedule the R2 page-tier work with runway, not under fire.
 */

export const START_ALERT_GB = 1;
const GB = 1024 * 1024 * 1024;

/**
 * The threshold this file size newly crosses, or null when no alert is due.
 * `lastAlertedGb` is the highest threshold already alerted (0 = none).
 * A file that jumped several GB since the last check (e.g. a big legacy
 * import) alerts once at its CURRENT floor, not once per skipped step.
 */
export function crossedGbThreshold(
  fileBytes: number,
  lastAlertedGb: number,
  startGb = START_ALERT_GB,
): number | null {
  const floorGb = Math.floor(fileBytes / GB);
  if (floorGb < startGb || floorGb <= lastAlertedGb) return null;
  return floorGb;
}

export function storageAlertText(args: {
  oracleName: string;
  oracleDid: string;
  userDid: string;
  fileBytes: number;
  gb: number;
}): string {
  const sizeGb = (args.fileBytes / GB).toFixed(2);
  return (
    `:warning: *Oracle user storage crossed ${args.gb} GB*\n` +
    `• Oracle: ${args.oracleName} (\`${args.oracleDid}\`)\n` +
    `• User: \`${args.userDid}\`\n` +
    `• Working-copy SQLite file: ${sizeGb} GB of the 10 GB Durable Object cap\n` +
    `At 10 GB this user's turns and exports start failing — ship the storage tier before then.`
  );
}

/**
 * Fire the webhook. Failures are logged and swallowed — an alert must never
 * take down the flush path it rides on.
 */
export async function postSlackAlert(
  webhookUrl: string,
  text: string,
): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.warn(
        `[size-alerts] Slack webhook responded ${res.status}: ${await res
          .text()
          .catch(() => '')}`,
      );
    }
  } catch (err) {
    console.warn(
      `[size-alerts] Slack webhook failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
