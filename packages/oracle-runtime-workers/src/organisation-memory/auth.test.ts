import { describe, expect, it } from 'vitest';
import { authenticateImport } from './auth';
import {
  boundFacts,
  parseImportBody,
  parseStatusBody,
  sha256,
} from './contract';
import fixture from './fixtures/v1.json';
import boundaries from './fixtures/organisation-memory-boundaries-v1.json';
import { signedFixture } from './fixtures/signed';

describe('reviewed organisation memory contract', () => {
  for (const operation of ['submit', 'status'] as const) {
    it.each(boundaries.cases)(
      `${operation} enforces shared boundary $name`,
      async (vector) => {
        const body = operation === 'submit' ? fixture.body : fixture.statusBody;
        const value =
          vector.value ?? (vector.repeat ?? '').repeat(vector.length ?? 0);
        const raw = JSON.stringify({ ...body, [vector.field]: value });
        const parse = async () =>
          operation === 'submit' ? parseImportBody(raw) : parseStatusBody(raw);
        const accepted = await parse().then(
          () => true,
          () => false,
        );
        expect(accepted).toBe(vector.valid);
      },
    );
  }
  it('matches the shared UTF-8 byte fixture and signed facts', async () => {
    expect(await sha256(fixture.rawBody)).toBe(fixture.requestDigest);
    expect(await parseImportBody(fixture.rawBody)).toEqual(fixture.body);
    expect(
      await boundFacts(
        'submit',
        fixture.rawBody,
        await parseImportBody(fixture.rawBody),
      ),
    ).toEqual(fixture.submitFacts);
    expect(
      await boundFacts(
        'status',
        fixture.rawStatusBody,
        parseStatusBody(fixture.rawStatusBody),
      ),
    ).toEqual(fixture.statusFacts);
  });
  it('verifies a real user invocation and minimal delegation through the chain resolver', async () => {
    const f = await signedFixture();
    expect(
      await authenticateImport(f.headers, f.raw, f.body, 'submit', f.config),
    ).toBe(f.grant);
  });
  it.each([
    ['visibility', 'invocation_binding_mismatch'],
    ['domainDid', 'invocation_binding_mismatch'],
    ['network', 'invocation_binding_mismatch'],
    ['userDid', 'invalid_invocation'],
  ])(
    'rejects a modified %s under the original signature',
    async (field, code) => {
      const f = await signedFixture();
      const changed = {
        ...f.body,
        [field]:
          field === 'visibility'
            ? 'public'
            : field === 'network'
              ? 'devnet'
              : field === 'userDid'
                ? 'did:ixo:ixo1attacker'
                : 'did:ixo:entity:33333333333333333333333333333333',
      };
      const body = await parseImportBody(JSON.stringify(changed));
      await expect(
        authenticateImport(
          f.headers,
          JSON.stringify(changed),
          body,
          'submit',
          f.config,
        ),
      ).rejects.toThrow(code);
    },
  );
  it('rejects altered content and unknown schema keys', async () => {
    await expect(
      parseImportBody(fixture.rawBody.replace('rail travel', 'air travel')),
    ).rejects.toThrow('content_hash_mismatch');
    await expect(
      parseImportBody(JSON.stringify({ ...fixture.body, roomId: '!attacker' })),
    ).rejects.toThrow('invalid_body');
    await expect(
      parseImportBody(
        JSON.stringify({
          ...fixture.body,
          chunks: Array(26).fill(fixture.body.chunks[0]),
        }),
      ),
    ).rejects.toThrow('invalid_body');
  });
  it('rejects a whitespace body change even when the parsed values match', async () => {
    const f = await signedFixture();
    await expect(
      authenticateImport(f.headers, `${f.raw} `, f.body, 'submit', f.config),
    ).rejects.toThrow('invocation_binding_mismatch');
  });
  // A few seconds past the 90 s cap, so a second boundary crossed while the
  // fixture signs cannot bring the expiry back under it.
  it.each([-1, 95])(
    'rejects invalid invocation remaining TTL %s',
    async (seconds) => {
      const f = await signedFixture({
        expiry: Math.floor(Date.now() / 1000) + seconds,
      });
      await expect(
        authenticateImport(f.headers, f.raw, f.body, 'submit', f.config),
      ).rejects.toThrow('invalid_invocation');
    },
  );
  it('accepts a 300 s grant from a client clock running ahead', async () => {
    const f = await signedFixture({
      grantExpiry: Math.floor(Date.now() / 1000) + 320,
    });
    expect(
      await authenticateImport(f.headers, f.raw, f.body, 'submit', f.config),
    ).toBe(f.grant);
  });
  it('rejects broad grants, wrong audience, excessive grant TTL and bare grants', async () => {
    const cases: [Parameters<typeof signedFixture>[0], string][] = [
      [
        { capabilities: [{ can: '*', with: 'ixo:memory' }] },
        'memory_grant_scope_mismatch',
      ],
      [{ grantAudience: 'did:ixo:ixo1other' }, 'invalid_memory_grant'],
      [{ audience: 'did:ixo:ixo1other' }, 'invalid_invocation'],
    ];
    for (const [options, code] of cases) {
      const f = await signedFixture(options);
      await expect(
        authenticateImport(f.headers, f.raw, f.body, 'submit', f.config),
      ).rejects.toThrow(code);
    }
    const long = await signedFixture({
      grantExpiry: Math.floor(Date.now() / 1000) + 345,
    });
    await expect(
      authenticateImport(
        long.headers,
        long.raw,
        long.body,
        'submit',
        long.config,
      ),
    ).rejects.toThrow('memory_grant_scope_mismatch');
    const f = await signedFixture();
    f.headers.delete('authorization');
    await expect(
      authenticateImport(f.headers, f.raw, f.body, 'submit', f.config),
    ).rejects.toThrow('invocation_required');
  });
  it('requires bound status auth with the original request digest, with no delegation', async () => {
    const f = await signedFixture({ operation: 'status' });
    f.headers.delete('x-ucan-delegation');
    const status = parseStatusBody(fixture.rawStatusBody);
    expect(
      await authenticateImport(f.headers, f.raw, status, 'status', f.config),
    ).toBeUndefined();
    await expect(
      authenticateImport(f.headers, f.raw, status, 'submit', f.config),
    ).rejects.toThrow('invocation_binding_mismatch');
    const changed = { ...status, requestDigest: 'a'.repeat(64) };
    await expect(
      authenticateImport(
        f.headers,
        JSON.stringify(changed),
        changed,
        'status',
        f.config,
      ),
    ).rejects.toThrow('invocation_binding_mismatch');
  });
});
