import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DelegationStore,
  UCAN_DELEGATION_STATE_KEY,
} from './delegation-store.js';

// Stub the Matrix state manager behind MatrixManager.getInstance(). MatrixError
// is a real subclass of Error carrying an `errcode` so the store's
// M_NOT_FOUND branch can be exercised. Defined via `vi.hoisted` so the mock
// factory (hoisted to the top of the file) can reference them.
const { getStateMock, setStateMock, MockMatrixError } = vi.hoisted(() => {
  class MockMatrixError extends Error {
    constructor(public errcode: string) {
      super(errcode);
      this.name = 'MatrixError';
    }
  }
  return {
    getStateMock: vi.fn(),
    setStateMock: vi.fn(),
    MockMatrixError,
  };
});

vi.mock('@ixo/matrix', () => ({
  MatrixManager: {
    getInstance: () => ({
      stateManager: { getState: getStateMock, setState: setStateMock },
    }),
  },
  MatrixError: MockMatrixError,
}));

const ROOM_ID = '!room:home';

describe('DelegationStore', () => {
  let store: DelegationStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new DelegationStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('read', () => {
    it('returns the validated delegation when present', async () => {
      const payload = {
        raw: 'raw-car',
        issuer: 'did:ixo:user',
        audience: 'did:ixo:oracle',
        expiration: 1234567890,
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      getStateMock.mockResolvedValue(payload);

      const result = await store.read(ROOM_ID);

      expect(getStateMock).toHaveBeenCalledWith(
        ROOM_ID,
        UCAN_DELEGATION_STATE_KEY,
      );
      expect(result).toEqual(payload);
    });

    it('returns null on M_NOT_FOUND (nothing stored yet)', async () => {
      getStateMock.mockRejectedValue(new MockMatrixError('M_NOT_FOUND'));

      expect(await store.read(ROOM_ID)).toBeNull();
    });

    it('returns null and swallows other read errors', async () => {
      getStateMock.mockRejectedValue(new Error('matrix down'));

      expect(await store.read(ROOM_ID)).toBeNull();
    });

    it('returns null when the stored payload fails validation', async () => {
      getStateMock.mockResolvedValue({ raw: 123 }); // raw must be a string

      expect(await store.read(ROOM_ID)).toBeNull();
    });
  });

  describe('write', () => {
    it('persists the delegation and stamps updatedAt', async () => {
      setStateMock.mockResolvedValue(undefined);

      await store.write(ROOM_ID, {
        raw: 'raw-car',
        issuer: 'did:ixo:user',
        audience: 'did:ixo:oracle',
        expiration: 1234567890,
      });

      expect(setStateMock).toHaveBeenCalledTimes(1);
      const arg = setStateMock.mock.calls[0]?.[0] as {
        roomId: string;
        stateKey: string;
        data: { raw: string; updatedAt: string };
      };
      expect(arg.roomId).toBe(ROOM_ID);
      expect(arg.stateKey).toBe(UCAN_DELEGATION_STATE_KEY);
      expect(arg.data.raw).toBe('raw-car');
      expect(typeof arg.data.updatedAt).toBe('string');
      expect(Number.isNaN(Date.parse(arg.data.updatedAt))).toBe(false);
    });
  });
});
