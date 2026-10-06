// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { type IOpenIDToken } from 'matrix-js-sdk';
import { type PropsWithChildren, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveKitAgent } from './use-livekit-agent.js';

const KEY = 'call-encryption-key-SECRET';

class FakeWorker {
  static created: FakeWorker[] = [];
  terminate = vi.fn();
  constructor() {
    FakeWorker.created.push(this);
  }
}

const { FakeRoom } = vi.hoisted(() => {
  class FakeRoom {
    static created: FakeRoom[] = [];
    on = vi.fn();
    off = vi.fn();
    setE2EEEnabled = vi.fn(async () => undefined);
    prepareConnection = vi.fn(async () => undefined);
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn(async () => undefined);
    localParticipant = { setMicrophoneEnabled: vi.fn(async () => undefined) };
    constructor(
      readonly options: { e2ee?: { worker: { terminate: () => void } } },
    ) {
      FakeRoom.created.push(this);
    }
  }
  return { FakeRoom };
});

vi.mock('livekit-client', () => ({
  Room: FakeRoom,
  ExternalE2EEKeyProvider: class {
    setKey = vi.fn(async () => undefined);
  },
  RoomEvent: {
    MediaDevicesError: 'mediaDevicesError',
    Disconnected: 'disconnected',
    EncryptionError: 'encryptionError',
    Connected: 'connected',
  },
  DeviceUnsupportedError: class extends Error {},
}));

const authedRequest = vi.fn();
vi.mock('../../../providers/oracles-provider/oracles-context.js', () => ({
  useOraclesContext: () => ({ authedRequest }),
}));
vi.mock('../../../hooks/use-oracles-config.js', () => ({
  useOraclesConfig: () => ({
    config: { apiUrl: 'https://oracle.test' },
    isReady: true,
  }),
}));
vi.mock('./use-connection-details.js', () => ({
  default: () => ({
    refreshConnectionDetails: vi.fn(),
    existingOrRefreshConnectionDetails: vi.fn(async () => ({
      url: 'wss://lk.test',
      jwt: 'jwt',
    })),
  }),
}));

const idToken: IOpenIDToken = {
  access_token: 'openid',
  expires_in: 3600,
  matrix_server_name: 'hs',
  token_type: 'Bearer',
};

function render(strict = false) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: PropsWithChildren) => {
    const tree = (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  return renderHook(
    () => useLiveKitAgent(idToken, 'did:ixo:oracle', () => undefined),
    { wrapper },
  );
}

describe('useLiveKitAgent', () => {
  beforeEach(() => {
    FakeWorker.created = [];
    FakeRoom.created = [];
    authedRequest.mockReset();
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('never writes the call encryption key to the console', async () => {
    const debug = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);
    const { result } = render();
    try {
      await act(async () => {
        await result.current.startCall({
          callId: 'call-1',
          encryptionKey: KEY,
        });
      });
      expect(debug).toHaveBeenCalled();
      for (const args of debug.mock.calls)
        for (const arg of args)
          expect(
            typeof arg === 'string' ? arg : (JSON.stringify(arg) ?? ''),
          ).not.toContain(KEY);
    } finally {
      debug.mockRestore();
    }
  });

  it('unmounting during a call leaves the room, ends the call and stops the E2EE worker', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const { result, unmount } = render();
    await act(async () => {
      await result.current.startCall({ callId: 'call-1', encryptionKey: KEY });
    });
    const room = FakeRoom.created.at(-1)!;
    const worker = FakeWorker.created.at(-1)!;

    unmount();

    expect(room.disconnect).toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(authedRequest).toHaveBeenCalledWith(
        'https://oracle.test/calls/call-1/update',
        'PATCH',
        expect.objectContaining({
          body: expect.stringContaining('"callStatus":"ended"'),
        }),
        'did:ixo:oracle',
      ),
    );
  });

  it('under StrictMode the room in use keeps a live E2EE worker', () => {
    const { result } = render(true);
    const fake = FakeRoom.created.find((r) =>
      Object.is(r, result.current.room),
    );
    expect(fake).toBeDefined();
    expect(fake!.options.e2ee?.worker.terminate).not.toHaveBeenCalled();
    expect(fake!.disconnect).not.toHaveBeenCalled();
  });
});
