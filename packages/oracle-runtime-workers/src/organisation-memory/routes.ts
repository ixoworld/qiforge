/* eslint-disable no-console -- console IS the logger on Workers (Logs/observability). */
import type { Hono } from 'hono';
import type { OracleWorkerEnv } from '../do/contracts';
import { userObjectName } from '../do/contracts';
import { sharedIxoDIDResolver, type AuthResult } from '../shell/auth';
import { authenticateImport } from './auth';
import {
  ImportError,
  IMPORT_LIMITS,
  importNetwork,
  parseImportBody,
  parseStatusBody,
  sha256,
  type ImportCommand,
  type ImportResult,
} from './contract';
import { assertDeployment, verifyDestination } from './destination';
import { boundedBytes, publicUrl } from './network';

export type ImportRpcResult =
  | { ok: true; result: ImportResult }
  | { ok: false; status: ImportError['status']; code: string };

function configuration(env: OracleWorkerEnv) {
  if (
    env.ORGANISATION_MEMORY_IMPORT_ENABLED !== 'true' ||
    !/^did:ixo:ixo1[a-z0-9]+$/.test(env.ORACLE_DID) ||
    !env.ORACLE_ENTITY_DID?.startsWith('did:ixo:entity:')
  )
    return null;
  try {
    publicUrl(env.BLOCKSYNC_GRAPHQL_URL);
  } catch {
    return null;
  }
  return {
    oracleDid: env.ORACLE_DID,
    oracleEntityDid: env.ORACLE_ENTITY_DID,
    network: importNetwork(env),
    blocksyncUrl: env.BLOCKSYNC_GRAPHQL_URL,
  };
}

const SIGNING_KEY_FOUND_TTL_MS = 5 * 60_000;
const SIGNING_KEY_MISSING_TTL_MS = 30_000;
/**
 * The account-room signer check, per isolate. The capabilities route is
 * public, and each check is an RPC to the single gateway object, which
 * re-reads Matrix room state for as long as it finds no mnemonic.
 */
const signingKeyChecks = new Map<
  string,
  { available: Promise<boolean>; expiresAt: number }
>();

async function signingKeyAvailable(env: OracleWorkerEnv): Promise<boolean> {
  if (
    typeof env.ORACLE_SIGNING_MNEMONIC === 'string' &&
    env.ORACLE_SIGNING_MNEMONIC.trim()
  )
    return true;
  const cached = signingKeyChecks.get(env.ORACLE_DID);
  if (cached && cached.expiresAt > Date.now()) return cached.available;
  const check = {
    available: (async () =>
      Boolean(
        await env.MATRIX_GATEWAY.get(
          env.MATRIX_GATEWAY.idFromName(env.ORACLE_DID),
        ).getOracleSigningMnemonic(),
      ))().catch(() => false),
    expiresAt: Date.now() + SIGNING_KEY_MISSING_TTL_MS,
  };
  signingKeyChecks.set(env.ORACLE_DID, check);
  if (await check.available)
    check.expiresAt = Date.now() + SIGNING_KEY_FOUND_TTL_MS;
  return check.available;
}

export function registerImportRoutes(
  app: Hono<{ Bindings: OracleWorkerEnv; Variables: { auth: AuthResult } }>,
): void {
  app.get('/memory/imports/capabilities', async (c) =>
    c.json({
      version: 1,
      enabled:
        Boolean(configuration(c.env)) && (await signingKeyAvailable(c.env)),
      network: importNetwork(c.env),
      oracleEntityDid: c.env.ORACLE_ENTITY_DID ?? '',
      oracleDid: c.env.ORACLE_DID,
      storageScope: 'oracle',
      limits: IMPORT_LIMITS,
    }),
  );
  for (const operation of ['submit', 'status'] satisfies (
    | 'submit'
    | 'status'
  )[]) {
    const path =
      operation === 'submit' ? '/memory/imports' : '/memory/imports/status';
    app.post(path, async (c) => {
      try {
        const config = configuration(c.env);
        if (!config) throw new ImportError(503, 'memory_import_disabled');
        const contentLength = Number(c.req.header('content-length') ?? 0);
        if (contentLength > IMPORT_LIMITS.maxBodyBytes)
          throw new ImportError(413, 'body_too_large');
        let raw: string;
        try {
          raw = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
          }).decode(
            await boundedBytes(
              new Response(c.req.raw.body),
              IMPORT_LIMITS.maxBodyBytes,
            ),
          );
        } catch (error) {
          if (
            error instanceof ImportError &&
            error.code === 'response_too_large'
          )
            throw new ImportError(413, 'body_too_large');
          throw new ImportError(400, 'invalid_utf8_body');
        }
        let command: ImportCommand;
        if (operation === 'submit') {
          const body = await parseImportBody(raw);
          const delegation = await authenticateImport(
            c.req.raw.headers,
            raw,
            body,
            operation,
            {
              oracleDid: config.oracleDid,
              didResolver: sharedIxoDIDResolver(config.blocksyncUrl),
            },
          );
          if (!delegation) throw new ImportError(401, 'memory_grant_required');
          command = {
            operation,
            body,
            requestDigest: await sha256(raw),
            delegation,
          };
        } else {
          const body = parseStatusBody(raw);
          await authenticateImport(c.req.raw.headers, raw, body, operation, {
            oracleDid: config.oracleDid,
            didResolver: sharedIxoDIDResolver(config.blocksyncUrl),
          });
          command = { operation, body, requestDigest: body.requestDigest };
        }
        // Status polls spend their own budget, so reconciling a lost submit
        // never pushes the next submit into 429.
        if (
          c.env.RATE_LIMIT &&
          !(
            await c.env.RATE_LIMIT.limit({
              key: `${config.oracleDid}|memory-import${operation === 'status' ? '-status' : ''}|${command.body.userDid}`,
            })
          ).success
        )
          return c.json({ code: 'rate_limited' }, 429);
        // Writing needs current domain authority. A status read returns the
        // caller's own receipt, whose stored scope the ledger re-checks, so
        // it stays readable while Blocksync or the config host is down.
        if (command.operation === 'submit')
          await verifyDestination(command.body, config);
        else assertDeployment(command.body, config);
        const id = c.env.USER_ORACLE.idFromName(
          userObjectName(command.body.userDid, config.oracleDid),
        );
        const outcome = await c.env.USER_ORACLE.get(
          id,
        ).organisationMemoryImport(command.body.userDid, command);
        if (!outcome.ok) return c.json({ code: outcome.code }, outcome.status);
        return outcome.result.outcome === 'received'
          ? c.json(outcome.result.receipt)
          : c.json({ code: outcome.result.code }, 404);
      } catch (error) {
        if (error instanceof ImportError)
          return c.json({ code: error.code }, error.status);
        // The cause only, never the request or its tokens.
        console.error(
          `[memory-import] ${operation} failed unexpectedly: ${
            error instanceof Error
              ? `${error.name}: ${error.message}`.slice(0, 300)
              : typeof error
          }`,
        );
        // The RPC can disconnect after dispatch. A 503 never asserts no effect.
        return c.json({ code: 'memory_import_unavailable' }, 503);
      }
    });
  }
}
