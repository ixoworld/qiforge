/**
 * Drill tools for the durable-run tests (docs/plans/durable-runs.md).
 *
 * Two deliberately slow tools the tests point the model at while they reset
 * the user object or drop the connection, and one deliberately large one:
 *
 *   - `drill_slow_write` — declared `effect: 'write'`: after a reset mid-call
 *     it must NOT run again (the model gets an "outcome unknown" result);
 *   - `drill_slow_read`  — declared `effect: 'read'`: after a reset it runs
 *     again;
 *   - `drill_big_result` — returns a result of exactly `chars` characters
 *     with a marker line in the middle, for the context-budget drill
 *     (docs/plans/context-budgets.md): the result cap must truncate it, save
 *     it whole, and the model must find the marker with `read_result`.
 *
 * `failFirst` on the slow tools makes the first call with a given token
 * fail like a dropped connection (`fetch failed`), for the harness drills
 * (docs/plans/workers-harness-hardening.md): a read is retried once and
 * succeeds, a write is not retried and its claim stays in the run ledger.
 *
 * Every execution reports `start` / `end` to `DRILL_RECORDER_URL` when set
 * (the harness runs a recorder), so a test can count executions without
 * trusting the runtime's own bookkeeping. Enabled only with
 * `DRILL_TOOLS=true` — never on a production oracle.
 */
import {
  OraclePlugin,
  tool,
  type PluginContext,
  type PluginManifest,
  type PluginTool,
} from '@ixo/oracle-runtime-workers';
import { z } from 'zod';

const NAME = 'drill';

const configSchema = z.object({
  DRILL_TOOLS: z.string().optional(),
  DRILL_RECORDER_URL: z.string().optional(),
});

const manifest: PluginManifest = {
  title: 'Drill',
  summary:
    'Test-only tools. Call drill_slow_write, drill_slow_read or drill_big_result exactly as the user asks (arguments verbatim) and report what they return.',
  whenToUse: [
    'The user explicitly asks to call drill_slow_write, drill_slow_read or drill_big_result.',
  ],
  whenNotToUse: ['Any other request.'],
  examples: [
    {
      user: 'Call drill_slow_write with token W-1 and ms 5000, then tell me the receipt.',
      tool: 'drill_slow_write',
      args: { token: 'W-1', ms: 5000 },
    },
  ],
  tags: ['test'],
  category: 'data',
  visibility: 'always',
  stability: 'experimental',
};

const MAX_MS = 60_000;

const inputSchema = z.object({
  token: z.string().min(1).describe('Opaque token echoed back in the receipt.'),
  ms: z
    .number()
    .int()
    .min(0)
    .max(MAX_MS)
    .default(5000)
    .describe('How long the tool takes, in milliseconds.'),
  failFirst: z
    .boolean()
    .optional()
    .describe(
      'Fail the first call with this token like a dropped connection; later calls succeed.',
    ),
});

/** Tokens whose first call already failed (per isolate: a test aid only). */
const failedOnce = new Set<string>();

async function record(
  recorderUrl: string | undefined,
  body: { token: string; phase: 'start' | 'end'; receipt: string },
): Promise<void> {
  if (!recorderUrl) return;
  try {
    await fetch(`${recorderUrl}/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    /* the recorder is a test aid; never fail the tool for it */
  }
}

function buildDrillTool(
  name: 'drill_slow_write' | 'drill_slow_read',
  effect: 'read' | 'write',
  recorderUrl: string | undefined,
): PluginTool {
  return tool(
    async (rawArgs) => {
      const { token, ms, failFirst } = inputSchema.parse(rawArgs);
      const receipt = `${name}:${token}:${crypto.randomUUID().slice(0, 8)}`;
      await record(recorderUrl, { token, phase: 'start', receipt });
      await new Promise((resolve) => setTimeout(resolve, ms));
      const key = `${name}:${token}`;
      if (failFirst && !failedOnce.has(key)) {
        failedOnce.add(key);
        throw new TypeError('fetch failed');
      }
      await record(recorderUrl, { token, phase: 'end', receipt });
      return { ok: true, token, receipt, ranMs: ms };
    },
    {
      name,
      effect,
      visibility: 'always',
      description:
        effect === 'write'
          ? 'Test-only SLOW WRITE: takes `ms` milliseconds and returns a receipt. Has an external effect (it is recorded), so it must never be repeated.'
          : 'Test-only SLOW READ: takes `ms` milliseconds and returns a receipt. No external effect; safe to repeat.',
      schema: inputSchema,
    },
  );
}

const MAX_BIG_CHARS = 3_000_000;

const bigResultSchema = z.object({
  chars: z
    .number()
    .int()
    .min(100)
    .max(MAX_BIG_CHARS)
    .describe('Exact length of the result, in characters.'),
  marker: z
    .string()
    .min(1)
    .max(80)
    .describe(
      'Echoed on the "MIDDLE-MARKER:" line in the middle of the result.',
    ),
});

/**
 * `chars` characters of numbered filler with `MIDDLE-MARKER: <marker>` at the
 * halfway point and `END-MARKER: <marker>` as the last line.
 */
export function buildBigResult(chars: number, marker: string): string {
  const middle = `MIDDLE-MARKER: ${marker}\n`;
  const end = `END-MARKER: ${marker}`;
  const body = Math.max(0, chars - middle.length - end.length);
  const half = Math.floor(body / 2);
  let out = '';
  let line = 0;
  const fill = (target: number): void => {
    while (out.length < target) {
      const text = `L${String(line).padStart(6, '0')} ${'.'.repeat(50)}\n`;
      out += text.slice(0, target - out.length);
      line += 1;
    }
  };
  fill(half);
  out += middle;
  fill(chars - end.length);
  out += end;
  return out.slice(0, chars);
}

function buildBigResultTool(): PluginTool {
  return tool(
    async (rawArgs) => {
      const { chars, marker } = bigResultSchema.parse(rawArgs);
      return buildBigResult(chars, marker);
    },
    {
      name: 'drill_big_result',
      effect: 'read',
      visibility: 'always',
      description:
        'Test-only LARGE READ: returns exactly `chars` characters of filler with a "MIDDLE-MARKER: <marker>" line halfway through and an "END-MARKER: <marker>" last line. No external effect.',
      schema: bigResultSchema,
    },
  );
}

export class DrillPlugin extends OraclePlugin {
  static readonly NAME = NAME;

  readonly name = NAME;

  readonly version = '0.1.0';

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  override readonly autoDetectHint = 'DRILL_TOOLS=true (tests only)';

  override autoDetect(config: unknown): boolean {
    return configSchema.parse(config).DRILL_TOOLS === 'true';
  }

  override getTools(ctx: PluginContext): PluginTool[] {
    const recorderUrl = configSchema.parse(ctx.config).DRILL_RECORDER_URL;
    return [
      buildDrillTool('drill_slow_write', 'write', recorderUrl),
      buildDrillTool('drill_slow_read', 'read', recorderUrl),
      buildBigResultTool(),
    ];
  }
}
