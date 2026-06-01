import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import { MatrixGroupChatsPlugin } from './index.js';

describe('MatrixGroupChatsPlugin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-group-chats-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has the expected identity and a valid manifest', () => {
    const plugin = new MatrixGroupChatsPlugin();
    expect(MatrixGroupChatsPlugin.NAME).toBe('matrix-group-chats');
    expect(plugin.name).toBe('matrix-group-chats');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Matrix Group Chats');
    expect(plugin.manifest.category).toBe('communication');
    expect(plugin.manifest.visibility).toBe('on-demand');

    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('is on by default — no autoDetect declared', () => {
    const plugin = new MatrixGroupChatsPlugin();
    expect(plugin.autoDetect).toBeUndefined();
  });

  it('configSchema declares all env vars with sensible defaults', () => {
    const plugin = new MatrixGroupChatsPlugin();
    const parsed = plugin.configSchema.parse({});
    expect(parsed.CHANNEL_MEMORY_SYNC_INTERVAL_MS).toBe(60_000);
    expect(parsed.GROUP_CHAT_ACTIVE_THREAD_TTL_MS).toBe(30 * 60 * 1000);
    expect(parsed.GROUP_CHAT_REQUIRE_POWER_LEVEL).toBe(0);
    expect(parsed.GROUP_CHAT_ROOM_INFO_TTL_MS).toBe(30 * 60 * 1000);
  });
});
