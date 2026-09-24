import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkersUcanService } from '../do/ucan-service';
import { requirePrivateOwnerState } from './owner-policy';
afterEach(() => vi.unstubAllGlobals());
describe('Reporter private owner policy', () => {
  it('requires authenticated confirmation of permanent owner-state privacy', async () => {
    const ucan = new WorkersUcanService({ oracleDid: 'did:ixo:oracle' });
    const mint = vi
      .spyOn(ucan, 'createInvocationFromDelegation')
      .mockResolvedValue({ invocation: 'request-local-token' });
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ version: 1, privateOwnerState: true, root: '/.oracles' }),
    );
    vi.stubGlobal('fetch', fetcher);
    await requirePrivateOwnerState(ucan, 'local-grant', 'https://vfs.example');
    expect(mint).toHaveBeenCalledWith(
      'local-grant',
      'https://vfs.example',
      {
        can: 'fs/list',
        with: 'ixo:filesystem/.oracles',
        nb: { hidden: ['/.oracles'] },
      },
      { maxTtlSeconds: 60 },
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://vfs.example/v1/reporter/owner-state-policy',
    );
    fetcher.mockResolvedValue(
      Response.json({
        version: 1,
        privateOwnerState: false,
        root: '/.oracles',
      }),
    );
    await expect(
      requirePrivateOwnerState(ucan, 'local-grant', 'https://vfs.example'),
    ).rejects.toThrow('policy unavailable');
    fetcher.mockResolvedValue(new Response('Not found', { status: 404 }));
    await expect(
      requirePrivateOwnerState(ucan, 'local-grant', 'https://vfs.example'),
    ).rejects.toThrow('policy unavailable');
  });
});
