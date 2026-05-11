import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import { SlackPlugin } from './slack.plugin.js';
import { SlackModule } from './slack.module.js';

describe('SlackPlugin', () => {
  it('has the expected identity and manifest shape', () => {
    const plugin = new SlackPlugin();
    expect(plugin.name).toBe('slack');
    expect(plugin.name).toBe(SlackPlugin.NAME);
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Slack');
    expect(plugin.manifest.visibility).toBe('silent');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.manifest.category).toBe('core');

    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('auto-detects only when SLACK_BOT_OAUTH_TOKEN is present', () => {
    const plugin = new SlackPlugin();
    expect(plugin.autoDetect?.({})).toBe(false);
    expect(plugin.autoDetect?.({ SLACK_BOT_OAUTH_TOKEN: '' })).toBe(false);
    expect(plugin.autoDetect?.({ SLACK_BOT_OAUTH_TOKEN: 'xoxb-...' })).toBe(true);
    expect(plugin.autoDetectHint).toBe('SLACK_BOT_OAUTH_TOKEN');
  });

  it('configSchema rejects missing bot token and accepts the documented env', () => {
    const plugin = new SlackPlugin();
    expect(plugin.configSchema!.safeParse({}).success).toBe(false);
    const ok = plugin.configSchema!.safeParse({
      SLACK_BOT_OAUTH_TOKEN: 'xoxb-abc',
      SLACK_APP_TOKEN: 'xapp-abc',
      SLACK_USE_SOCKET_MODE: 'true',
      SLACK_MAX_RECONNECT_ATTEMPTS: '12',
      SLACK_RECONNECT_DELAY_MS: '2000',
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.SLACK_USE_SOCKET_MODE).toBe('true');
      expect(ok.data.SLACK_MAX_RECONNECT_ATTEMPTS).toBe(12);
      expect(ok.data.SLACK_RECONNECT_DELAY_MS).toBe(2000);
    }
  });

  it('contributes [SlackModule] via getNestModules()', () => {
    const plugin = new SlackPlugin();
    const modules = plugin.getNestModules?.();
    expect(modules).toEqual([SlackModule]);
  });

  it('contributes no agent-visible tools, sub-agents, or middlewares', () => {
    const plugin = new SlackPlugin();
    expect(plugin.getTools).toBeUndefined();
    expect(plugin.getSubAgents).toBeUndefined();
    expect(plugin.getMiddlewares).toBeUndefined();
  });
});
