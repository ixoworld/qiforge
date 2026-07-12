import {
  createHash,
  generateKeyPairSync,
  sign as ed25519Sign,
  type KeyObject,
} from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { EvalsEngineClient } from './evals-client.js';
import { createVerifyUdidTool } from './evals-verify.js';

const BASE_URL = 'https://evals.test';
const COUNTERPARTY_URL = 'https://other-oracle.test/oracle-api';

/**
 * Real Ed25519 material: the tool performs actual cryptographic verification
 * via @ixo/udid-verify, so the fixtures are genuinely signed compact JWSs and
 * genuinely published JWK keys — nothing here is stubbed except HTTP.
 */
const issuer = generateKeyPairSync('ed25519');

function rawPublicKey(publicKey: KeyObject): Buffer {
  return Buffer.from(
    publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  );
}

/** base64url(sha256(raw public key)) — the engine's kid derivation. */
function kidOf(publicKey: KeyObject): string {
  return createHash('sha256')
    .update(rawPublicKey(publicKey))
    .digest('base64url');
}

function publishedKeys(publicKey: KeyObject): unknown {
  return {
    keys: [
      {
        kid: kidOf(publicKey),
        kty: 'OKP',
        crv: 'Ed25519',
        alg: 'EdDSA',
        x: rawPublicKey(publicKey).toString('base64url'),
        active: true,
      },
    ],
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = sortKeysDeep(o[k]);
  return out;
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

/** Sign the canonical (deep key-sorted) JSON payload as a compact EdDSA JWS. */
function signReceipt(payload: Record<string, unknown>): string {
  const header = b64url(
    JSON.stringify({ alg: 'EdDSA', kid: kidOf(issuer.publicKey) }),
  );
  const body = b64url(JSON.stringify(sortKeysDeep(payload)));
  const signature = ed25519Sign(
    null,
    Buffer.from(`${header}.${body}`),
    issuer.privateKey,
  );
  return `${header}.${body}.${b64url(signature)}`;
}

/** Minimal schema-valid UDID payload (oracle-udid base payload schema). */
const RECEIPT_PAYLOAD = {
  iss: 'https://oracle.example/issuer',
  sub: 'claim-1',
  aud: 'did:example:aud',
  iat: 1_700_000_000,
  jti: 'jti-1',
  kind: 'oracle.eval.v1',
  ver: 1,
  act: { cap: 'urn:cap:test', rub: { id: 'rubric-v1' } },
  res: { outcome: 1, reason: 'approve', patch: { status: 'done' } },
};

function client(): EvalsEngineClient {
  return new EvalsEngineClient({ baseUrl: BASE_URL });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('verify_evaluation_udid', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('verifies a presented receipt against the configured engine keys', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(publishedKeys(issuer.publicKey)),
    );
    const tool = createVerifyUdidTool(client());

    const result = (await tool.handler(
      {
        compactJws: signReceipt(RECEIPT_PAYLOAD),
        expectedAud: 'did:example:aud',
      },
      makeRuntimeContext(),
    )) as Record<string, unknown>;

    expect(fetchSpy).toHaveBeenCalledWith(
      `${BASE_URL}/v1/issuer-keys`,
      expect.anything(),
    );
    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.kid).toBe(kidOf(issuer.publicKey));
    expect(result.receipt).toMatchObject({
      sub: 'claim-1',
      aud: 'did:example:aud',
      outcome: 1,
      outcomeLabel: 'approved',
      reason: 'approve',
      patch: { status: 'done' },
    });
  });

  it('fetches counterparty keys from issuerUrl, keeping a reverse-proxy subpath', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(publishedKeys(issuer.publicKey)),
    );
    const tool = createVerifyUdidTool(client());

    const result = (await tool.handler(
      {
        compactJws: signReceipt(RECEIPT_PAYLOAD),
        expectedAud: 'did:example:aud',
        issuerUrl: COUNTERPARTY_URL,
      },
      makeRuntimeContext(),
    )) as Record<string, unknown>;

    expect(fetchSpy).toHaveBeenCalledWith(
      `${COUNTERPARTY_URL}/v1/issuer-keys`,
      expect.anything(),
    );
    expect(result.valid).toBe(true);
    expect(result.issuerKeysSource).toBe(COUNTERPARTY_URL);
  });

  it('fails closed on an audience mismatch', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(publishedKeys(issuer.publicKey)),
    );
    const tool = createVerifyUdidTool(client());

    const result = (await tool.handler(
      {
        compactJws: signReceipt(RECEIPT_PAYLOAD),
        expectedAud: 'did:example:someone-else',
      },
      makeRuntimeContext(),
    )) as Record<string, unknown>;

    expect(result.valid).toBe(false);
    expect(result.failures).toContain('audience_mismatch');
    expect(result.receipt).toBeUndefined();
  });

  it('fails closed on a tampered payload', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(publishedKeys(issuer.publicKey)),
    );
    const tool = createVerifyUdidTool(client());

    const genuine = signReceipt(RECEIPT_PAYLOAD);
    const [header, , signature] = genuine.split('.');
    const forgedBody = b64url(
      JSON.stringify(
        sortKeysDeep({
          ...RECEIPT_PAYLOAD,
          res: {
            outcome: 1,
            reason: 'approve',
            patch: { status: 'done', paid: true },
          },
        }),
      ),
    );

    const result = (await tool.handler(
      {
        compactJws: `${header}.${forgedBody}.${signature}`,
        expectedAud: 'did:example:aud',
      },
      makeRuntimeContext(),
    )) as Record<string, unknown>;

    expect(result.valid).toBe(false);
    expect(result.failures).toContain('signature_invalid');
  });

  it('fetches the receipt by claimId from the engine, then verifies it', async () => {
    const jws = signReceipt(RECEIPT_PAYLOAD);
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          claimId: 'claim-1',
          compactJws: jws,
          payload: RECEIPT_PAYLOAD,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(publishedKeys(issuer.publicKey)));
    const tool = createVerifyUdidTool(client());

    const result = (await tool.handler(
      { claimId: 'claim-1', expectedAud: 'did:example:aud' },
      makeRuntimeContext(),
    )) as Record<string, unknown>;

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      `${BASE_URL}/v1/claims/claim-1/udid`,
      expect.anything(),
    );
    expect(result.valid).toBe(true);
  });

  it('passes udid_not_issued through as an actionable error', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ error: 'udid_not_issued' }, 404),
    );
    const tool = createVerifyUdidTool(client());

    const result = await tool.handler(
      { claimId: 'claim-1', expectedAud: 'did:example:aud' },
      makeRuntimeContext(),
    );

    expect(result).toEqual({ error: 'udid_not_issued' });
  });

  it('reports an unreachable or malformed issuer-keys endpoint as an actionable error', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('down', { status: 503, statusText: 'Unavailable' }),
    );
    const tool = createVerifyUdidTool(client());

    const result = (await tool.handler(
      {
        compactJws: signReceipt(RECEIPT_PAYLOAD),
        expectedAud: 'did:example:aud',
      },
      makeRuntimeContext(),
    )) as Record<string, unknown>;

    expect(result.error).toBe('issuer_keys_unavailable');
  });

  it('rejects a call with neither compactJws nor claimId', async () => {
    const tool = createVerifyUdidTool(client());
    await expect(
      tool.handler({ expectedAud: 'did:example:aud' }, makeRuntimeContext()),
    ).rejects.toThrow(/compactJws or claimId/);
  });
});
