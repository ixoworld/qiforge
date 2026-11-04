import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsksPlugin } from './asks.plugin';
import { asksMcpUrlOf } from './oauth';
import { isAsksUploadAddress } from './tools';

const ON = {
  ASKS_TOKEN_KEY: 'k'.repeat(44),
  ORACLE_PUBLIC_URL: 'https://oracle.example.org',
  NETWORK: 'testnet',
};

afterEach(() => vi.restoreAllMocks());

describe('asks network', () => {
  it('picks the connector by NETWORK and nothing else', () => {
    expect(asksMcpUrlOf('mainnet')).toBe('https://asks.world/v1/mcp');
    expect(asksMcpUrlOf('testnet')).toBe('https://test.asks.world/v1/mcp');
    expect(asksMcpUrlOf('devnet')).toBe('https://dev.asks.world/v1/mcp');
    for (const other of [undefined, '', 'local', 'Mainnet', 'toString'])
      expect(asksMcpUrlOf(other)).toBeNull();
  });

  it('trusts upload addresses only on the asks hosts of that table', () => {
    const upload = (host: string) =>
      `https://${host}/draft-uploads/du_${'a'.repeat(43)}/`;
    for (const network of ['mainnet', 'testnet', 'devnet']) {
      const mcpUrl = asksMcpUrlOf(network)!;
      expect(isAsksUploadAddress(upload('api.asks.world'), mcpUrl)).toBe(true);
      expect(isAsksUploadAddress(upload('test.api.asks.world'), mcpUrl)).toBe(
        true,
      );
      expect(isAsksUploadAddress(upload('asks.world.evil.io'), mcpUrl)).toBe(
        false,
      );
    }
  });
});

describe('AsksPlugin.autoDetect', () => {
  it('is on with ASKS_TOKEN_KEY, ORACLE_PUBLIC_URL and a known NETWORK', () => {
    expect(new AsksPlugin().autoDetect(ON)).toBe(true);
  });

  it('is off, silently, without the secret or the public URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = new AsksPlugin();
    expect(plugin.autoDetect({ ...ON, ASKS_TOKEN_KEY: '' })).toBe(false);
    expect(plugin.autoDetect({ ...ON, ORACLE_PUBLIC_URL: undefined })).toBe(
      false,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('is off, and says why, with NETWORK missing or unknown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = new AsksPlugin();
    expect(plugin.autoDetect({ ...ON, NETWORK: undefined })).toBe(false);
    expect(plugin.autoDetect({ ...ON, NETWORK: 'localnet' })).toBe(false);
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      '[asks] off: NETWORK is not set; asks needs mainnet, testnet or devnet',
      '[asks] off: NETWORK is "localnet"; asks needs mainnet, testnet or devnet',
    ]);
  });
});
