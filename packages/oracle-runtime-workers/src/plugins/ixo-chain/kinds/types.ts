/**
 * The contract every `chain_lookup` kind implements. A kind is one named
 * read the model can ask for: its arguments, a one-line summary for the
 * catalogue `describe_chain_kinds` returns, a longer explanation shown
 * only on request, and a plan that answers it either as one aliased field
 * of the call's single Blocksync document or as chain REST reads.
 *
 * Arguments are validated by the kind's own schema inside
 * {@link defineKind}: `chain_lookup`'s tool schema only names the kind, so
 * the catalogue does not cost context on every turn.
 */
import type { z } from 'zod';
import type { UserIdentity } from '../../../core/user-identity';
import type { TokenDisplay } from '../denoms';
import type { ChainCall, Failure, Outcome, Source } from '../http';
import type { Subject } from '../queries';
import type { Absent } from '../rest';

/** How a kind bounds one REST read, and which answers mean "none". */
export interface KindRestOptions {
  label: string;
  notFoundOn404?: boolean;
  maxBytes?: number;
  /**
   * HTTP statuses that mean "there is none" (e.g. `[400, 404]` for a vote
   * never cast): such an answer is `{ ok: true, absent: true }`, not a
   * failure, and is not logged.
   */
  noneOn?: readonly number[];
}

/** What a kind's plan may use: the call, the user and the call's shared readers. */
export interface KindContext {
  call: ChainCall;
  identity: UserIdentity;
  /**
   * Rows a list kind returns: the request's `first`, already clamped to
   * 1–20 and scaled down for a batch of several requests.
   */
  first: number;
  /**
   * A chain REST GET through the call's shared concurrency limit and the
   * plugin's retry policy. `path` is appended to the REST base and must
   * only carry values the kind validated.
   */
  rest<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: KindRestOptions & { noneOn?: undefined },
  ): Promise<Outcome<z.infer<S>>>;
  rest<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: KindRestOptions & { noneOn: readonly number[] },
  ): Promise<Outcome<z.infer<S>> | Absent>;
  /**
   * How a bank denom is shown (`denoms.ts`, with the oracle's IBC table:
   * the network's built-in entries and `IXO_CHAIN_IBC_DENOMS`). Lookups are
   * cached per isolate and run through the call's REST limit; one request
   * looks up at most a fixed number of distinct denoms, and any further one
   * is shown unread (base units, `metadataUnavailable`).
   */
  display(denom: string): Promise<TokenDisplay>;
}

/** One kind's answer. `subject` says whether it is about the user. */
export type KindResult =
  | {
      ok: true;
      data: unknown;
      subject?: Subject;
      /** The rows a list kind asked for. */
      first?: number;
    }
  | ({ ok: false } & Failure);

/** How a validated request is answered. */
export type KindPlan =
  | {
      source: 'blocksync';
      /** The aliased root field (`${alias}: …`) for the call's one document. */
      field(alias: string): string;
      /** The answer from that alias's data (null when the index has none). */
      shape(raw: unknown): KindResult | Promise<KindResult>;
    }
  | {
      source: 'chain';
      run(): Promise<KindResult>;
    };

/** A request the kind refuses before any read: the detail the model sees. */
export type KindInvalid = { invalid: string };

/** A registered kind, its argument types erased. */
export interface KindDef {
  name: string;
  /** One line for the catalogue: what question it answers. */
  summary: string;
  /** What the result means (types, units, how to read it); shown only on request. */
  explain: string;
  source: Source;
  /** Whether the kind returns a list honouring `first`. */
  list: boolean;
  /** The argument schema (for `describe_chain_kinds`). */
  args: z.ZodType;
  /** A valid `args` object. */
  example: Record<string, unknown>;
  /** Validates `rawArgs` and returns the plan, or why the request is refused. */
  plan(rawArgs: unknown, ctx: KindContext): KindPlan | KindInvalid;
}

/** The argument problems as one sentence naming what the kind expects. */
function invalidArgs(name: string, error: z.ZodError): KindInvalid {
  const issues = error.issues
    .slice(0, 3)
    .map((issue) =>
      issue.path.length
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message,
    )
    .join('; ');
  return {
    invalid: `Invalid args for kind "${name}" (${issues}). Call describe_chain_kinds with ["${name}"] for its arguments.`,
  };
}

/**
 * A kind from its typed spec: `plan` receives the arguments already parsed
 * by `args`, so a kind never reads unvalidated input.
 */
export function defineKind<S extends z.ZodType>(spec: {
  name: string;
  summary: string;
  explain: string;
  source: Source;
  list: boolean;
  args: S;
  example: z.input<S> & Record<string, unknown>;
  plan(args: z.output<S>, ctx: KindContext): KindPlan | KindInvalid;
}): KindDef {
  return {
    name: spec.name,
    summary: spec.summary,
    explain: spec.explain,
    source: spec.source,
    list: spec.list,
    args: spec.args,
    example: spec.example,
    plan(rawArgs, ctx) {
      const parsed = spec.args.safeParse(rawArgs ?? {});
      return parsed.success
        ? spec.plan(parsed.data, ctx)
        : invalidArgs(spec.name, parsed.error);
    },
  };
}
