/**
 * The oracle half of the `sign_transaction` round trip, shared by every
 * plugin that asks the user's Portal wallet to sign (`sign_ixo_transaction`,
 * the POD creator's `request_pod_signature`): send the validated action args
 * over the realtime channel and read the answer through the action's result
 * contract. The oracle never signs or broadcasts; the wallet does.
 */
import {
  SIGN_TRANSACTION_ACTION_NAME,
  SignTransactionActionResultSchema,
  normalizeWalletSignResult,
  type SignTransactionActionArgs,
} from '@ixo/ixo-transaction';
import { reportsUnknownOutcome } from '@ixo/common/ai/frontend-bridge';
import type {
  FrontendCallSurface,
  RuntimeContext,
} from '../../plugin-api/types';

/** How a signing request ended, before a plugin adds its own context. */
export type WalletSignatureOutcome =
  | {
      status: 'signed';
      transactionHash?: string;
      code?: number;
      height?: string | number;
    }
  | {
      /** Included in a block but failed: the hash and code are real. */
      status: 'failed';
      code: number;
      transactionHash?: string;
      height?: string | number;
      error: string;
    }
  | { status: 'rejected' | 'error'; error: string }
  | {
      status: 'timeout';
      /**
       * The wallet may still sign after the oracle stopped waiting. The
       * tool-execution middleware reads `outcome: 'unknown'`: the write claim
       * stays and the same request is not dispatched again in the thread.
       */
      outcome: 'unknown';
      error: string;
    }
  | { status: 'unavailable'; error: string };

/** The client SDK's answer to an `action_call` for an action it has no handler for. */
const MISSING_HANDLER = `Action tool ${SIGN_TRANSACTION_ACTION_NAME} not found`;

/**
 * A wallet's refusal as its error text words it. SignX reports no structured
 * reason, so a refusal is recognised from the message.
 */
const WALLET_REFUSAL = /\b(?:reject|denied|declin|cancel)/i;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type WalletChannel =
  | { ok: true; frontend: FrontendCallSurface; sessionId: string }
  | { ok: false; reason: string };

/**
 * The turn's way to the wallet: a session with a realtime channel and a
 * Portal browser connected to it.
 */
function walletChannel(ctx: RuntimeContext): WalletChannel {
  const sessionId = ctx.session.id;
  const frontend = ctx.frontend;
  if (!sessionId || !frontend) {
    return {
      ok: false,
      reason:
        'Wallet signing needs a Portal session with a realtime connection, which this conversation does not have.',
    };
  }
  if (!frontend.hasClient(sessionId)) {
    return {
      ok: false,
      reason:
        "No Portal browser is connected to this session, so the transaction cannot reach the user's wallet. Ask the user to open the chat in the Portal.",
    };
  }
  return { ok: true, frontend, sessionId };
}

/**
 * Why a signing request cannot reach the user's wallet from this turn, or
 * null when it can. Nothing is sent either way.
 */
export function walletUnavailableReason(ctx: RuntimeContext): string | null {
  const channel = walletChannel(ctx);
  return channel.ok ? null : channel.reason;
}

/** Map a settled bridge call (or its rejection) to an outcome. */
function settledOutcome(
  outcome: { ok: true; value: unknown } | { ok: false; error: string },
  timeoutMs: number,
): WalletSignatureOutcome {
  if (outcome.ok && reportsUnknownOutcome(outcome.value)) {
    // The bridge's own answer when none arrived: the deadline passed, the
    // socket the request went to is gone, or the turn ended after the
    // request was sent. The wallet may still have signed.
    return {
      status: 'timeout',
      outcome: 'unknown',
      error: `The Portal wallet did not answer within ${timeoutMs / 1000} s, or its tab disconnected, and the request timed out. The outcome is unknown: the user may still sign it in their wallet. Do not send it again; ask the user whether it went through.`,
    };
  }
  if (outcome.ok) {
    // The Portal handler answers with the result contract; anything else is
    // a raw wallet response from a Portal with its own handler.
    const contract = SignTransactionActionResultSchema.safeParse(outcome.value);
    const summary = contract.success
      ? contract.data
      : normalizeWalletSignResult(outcome.value);
    if (summary.delivered) {
      return {
        status: 'failed',
        code: summary.delivered.code,
        ...(summary.delivered.transactionHash !== undefined
          ? { transactionHash: summary.delivered.transactionHash }
          : {}),
        ...(summary.delivered.height !== undefined
          ? { height: summary.delivered.height }
          : {}),
        error:
          summary.error ??
          `The transaction failed on chain with code ${summary.delivered.code}`,
      };
    }
    if (!summary.success) {
      return {
        status: 'error',
        error: summary.error ?? 'The wallet reported a failed transaction',
      };
    }
    return {
      status: 'signed',
      ...(summary.transactionHash !== undefined
        ? { transactionHash: summary.transactionHash }
        : {}),
      ...(summary.code !== undefined ? { code: summary.code } : {}),
      ...(summary.height !== undefined ? { height: summary.height } : {}),
    };
  }
  if (outcome.error === MISSING_HANDLER) {
    return {
      status: 'unavailable',
      error:
        'This Portal does not handle wallet signing (no sign_transaction handler is registered), so nothing was sent to a wallet.',
    };
  }
  // A rejected call carries only the Portal's error text (a delivered
  // transaction comes back as `failed` above, with its code and hash), so a
  // refusal is read from that text — never from a chain log.
  return {
    status: WALLET_REFUSAL.test(outcome.error) ? 'rejected' : 'error',
    error: outcome.error,
  };
}

/**
 * Send `sign_transaction` to the session's Portal tab and wait for the
 * wallet. The call is bound to the one socket it was sent to and ends as an
 * unknown outcome on the deadline, a lost socket or the turn's abort after
 * it was sent. Without a way to the wallet it is `unavailable` and nothing
 * is sent.
 */
export async function requestWalletSignature(
  ctx: RuntimeContext,
  request: {
    args: SignTransactionActionArgs;
    /** Readable prefix of the call id, e.g. `ixo_tx`. */
    callIdPrefix: string;
    timeoutMs: number;
  },
): Promise<WalletSignatureOutcome> {
  const channel = walletChannel(ctx);
  if (!channel.ok) return { status: 'unavailable', error: channel.reason };
  const toolCallId = `${request.callIdPrefix}_${ctx.session.requestId || 'noreq'}_${crypto
    .randomUUID()
    .slice(0, 8)}`;
  const outcome = await channel.frontend
    .callAgAction({
      sessionId: channel.sessionId,
      toolCallId,
      toolName: SIGN_TRANSACTION_ACTION_NAME,
      args: request.args,
      timeoutMs: request.timeoutMs,
      signal: ctx.abortSignal,
    })
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: errorText(error) }),
    );
  return settledOutcome(outcome, request.timeoutMs);
}
