import { afterEach, describe, expect, it, vi } from 'vitest';
import { context, manifest } from '../../../work/test-fixtures';
import { createSkillsTools, loadRegistrySkillManifest } from './skills-tools';
const options = {
  baseUrl: 'https://skills.example',
  network: 'testnet',
  ucanBuilder: async () => 'skills-token',
};
afterEach(() => vi.unstubAllGlobals());
describe('trusted selected skill sidecar', () => {
  it('preserves ordinary discovery when a sidecar is malformed and rejects selected execution', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        capsules: [
          {
            cid: 'capsule1',
            name: 'research',
            metadata: { qiforgeManifest: 'invalid' },
          },
        ],
        pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
      }),
    );
    const list = createSkillsTools(options)[0];
    if (!list) throw new Error('Missing list tool');
    expect(await list.handler({}, context())).toMatchObject({
      skills: [{ cid: 'capsule1', title: 'research' }],
    });
    await expect(
      loadRegistrySkillManifest(context(), options, 'capsule1'),
    ).rejects.toThrow();
  });
  it('loads exact authenticated sidecar and rejects a mismatched CID', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        capsules: [
          {
            cid: 'capsule1',
            name: 'research',
            metadata: { qiforgeManifest: JSON.stringify(manifest) },
          },
        ],
        pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(
      (await loadRegistrySkillManifest(context(), options, 'capsule1'))
        .manifest,
    ).toEqual(manifest);
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(
      loadRegistrySkillManifest(
        context(),
        { ...options, ucanBuilder: async () => undefined },
        'capsule1',
      ),
    ).rejects.toThrow(/Authenticated/);
    vi.stubGlobal('fetch', async () =>
      Response.json({
        capsules: [
          {
            cid: 'capsule1',
            name: 'research',
            metadata: {
              qiforgeManifest: JSON.stringify({
                ...manifest,
                skillId: 'other',
              }),
            },
          },
        ],
        pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
      }),
    );
    await expect(
      loadRegistrySkillManifest(context(), options, 'capsule1'),
    ).rejects.toThrow(/matching operational/);
  });
});
