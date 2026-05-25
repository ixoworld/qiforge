import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { makeConfig } from '../../testing/nest-doubles.js';
import type { UcanService } from '../ucan/ucan.service.js';
import type { AttachmentDto } from './dto/send-message.dto.js';
import type { FileProcessingCreditSink } from './file-processing-credit-sink.port.js';
import {
  FileProcessingService,
  setFileProcessingProvider,
} from './file-processing.service.js';

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TOTAL_SIZE = 50 * 1024 * 1024;
const MATRIX_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_REDIRECT_COUNT = 5;

const matrixDownloadContent = vi.fn();
const matrixGetEvent = vi.fn();
const matrixDecryptMedia = vi.fn();
const matrixGetInstance = vi.fn();

vi.mock('@ixo/matrix', () => ({
  MatrixManager: {
    getInstance: (...args: unknown[]) => matrixGetInstance(...args),
  },
}));

const loadFileFromBufferMock = vi.fn();
vi.mock('@ixo/common', () => ({
  loadFileFromBuffer: (...args: unknown[]) => loadFileFromBufferMock(...args),
}));

const ROOM_ID = '!room:home.server';
const USER_DID = 'did:ixo:user-1';

function makeAttachment(overrides: Partial<AttachmentDto> = {}): AttachmentDto {
  return {
    filename: 'file.txt',
    mimetype: 'text/plain',
    mxcUri: 'mxc://home.server/abc',
    size: 1024,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function aiResponse(
  content: string,
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  },
): Response {
  return jsonResponse({
    choices: [{ message: { content } }],
    usage,
    model: 'test-model',
  });
}

function redirectResponse(location: string, status = 301): Response {
  return new Response(null, {
    status,
    headers: { location },
  });
}

function streamResponse(
  chunks: Uint8Array[],
  init: {
    status?: number;
    headers?: Record<string, string>;
  } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

describe('FileProcessingService', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let ucanService: { createServiceInvocation: ReturnType<typeof vi.fn> };
  let creditSink: {
    deductForFileProcessing: ReturnType<typeof vi.fn>;
  };
  let svc: FileProcessingService;

  beforeAll(() => {
    setFileProcessingProvider(() => ({
      apiKey: 'test',
      baseURL: 'https://x',
      headers: {},
      model: 'test',
    }));
  });

  afterAll(() => {
    setFileProcessingProvider(() => {
      throw new Error(
        'FileProcessingService provider config not initialised — call setFileProcessingProvider() at boot',
      );
    });
  });

  beforeEach(() => {
    vi.resetAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    ucanService = {
      createServiceInvocation: vi.fn().mockResolvedValue(null),
    } satisfies Partial<UcanService>;
    creditSink = {
      deductForFileProcessing: vi.fn().mockResolvedValue(undefined),
    } satisfies FileProcessingCreditSink;
    matrixGetInstance.mockReturnValue({
      getClient: () => ({
        mxClient: {
          downloadContent: matrixDownloadContent,
          getEvent: matrixGetEvent,
          crypto: { decryptMedia: matrixDecryptMedia },
        },
      }),
    });
    svc = new FileProcessingService(
      makeConfig({}),
      ucanService as unknown as UcanService,
      creditSink,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  describe('processAttachments — size enforcement', () => {
    it('rejects when reportedTotal exceeds MAX_TOTAL_SIZE before any download', async () => {
      const huge = makeAttachment({ size: MAX_TOTAL_SIZE + 1 });
      await expect(
        svc.processAttachments([huge], ROOM_ID, USER_DID),
      ).rejects.toThrow(/exceeds budget/);
      expect(matrixDownloadContent).not.toHaveBeenCalled();
    });

    it('emits placeholder error mid-batch when cumulative downloaded exceeds MAX_TOTAL_SIZE', async () => {
      const big = Buffer.alloc(20 * 1024 * 1024, 1);
      matrixDownloadContent.mockResolvedValue({ data: big });
      const atts = [
        makeAttachment({ filename: 'a.txt', mxcUri: 'mxc://h/a' }),
        makeAttachment({ filename: 'b.txt', mxcUri: 'mxc://h/b' }),
        makeAttachment({ filename: 'c.txt', mxcUri: 'mxc://h/c' }),
      ];
      // Drop reported size so the first reportedTotal check passes.
      for (const a of atts) delete a.size;

      const result = await svc.processAttachments(atts, ROOM_ID, USER_DID);

      // First two succeed (40MB cumulative); third pushes to 60MB → caught by
      // for-loop catch → placeholder text emitted, still returned.
      expect(matrixDownloadContent).toHaveBeenCalledTimes(3);
      expect(result.texts[2]).toMatch(/exceeds budget/);
    });

    it('processes attachments sequentially (calls do not overlap)', async () => {
      const order: string[] = [];
      let inFlight = 0;
      let maxConcurrent = 0;
      matrixDownloadContent.mockImplementation(async (uri: string) => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        order.push(`start:${uri}`);
        await new Promise((r) => setTimeout(r, 1));
        order.push(`end:${uri}`);
        inFlight--;
        return { data: Buffer.from('hello world', 'utf-8') };
      });

      await svc.processAttachments(
        [
          makeAttachment({ filename: 'a.txt', mxcUri: 'mxc://h/a' }),
          makeAttachment({ filename: 'b.txt', mxcUri: 'mxc://h/b' }),
        ],
        ROOM_ID,
        USER_DID,
      );

      expect(maxConcurrent).toBe(1);
      expect(order).toEqual([
        'start:mxc://h/a',
        'end:mxc://h/a',
        'start:mxc://h/b',
        'end:mxc://h/b',
      ]);
    });

    it('catches per-attachment errors and emits an error-text placeholder', async () => {
      const att = makeAttachment({
        filename: 'bad.txt',
        mxcUri: 'ftp://h/x',
      });
      delete att.size;

      const result = await svc.processAttachments([att], ROOM_ID, USER_DID);

      expect(result.texts[0]).toMatch(/failed to process/i);
      expect(result.metadata).toHaveLength(1);
    });
  });

  describe('processAttachments — SSRF', () => {
    // Each test inlines its `await expect(...).rejects.toThrow()` so the
    // vitest/expect-expect rule sees the assertion directly. (A shared
    // `expectBlocked` helper hid the assertion behind a function call and
    // the rule could no longer detect it.)

    it('rejects 127.0.0.1', async () => {
      await expect(
        svc.processFileFromUrl('http://127.0.0.1/file.pdf'),
      ).rejects.toThrow();
    });

    it('rejects 169.254.169.254 (cloud metadata)', async () => {
      await expect(
        svc.processFileFromUrl(
          'http://169.254.169.254/latest/meta-data/file.pdf',
        ),
      ).rejects.toThrow();
    });

    it('rejects ::1 (IPv6 loopback)', async () => {
      await expect(
        svc.processFileFromUrl('http://[::1]/file.pdf'),
      ).rejects.toThrow();
    });

    it('rejects ::ffff:127.0.0.1 (IPv4-mapped IPv6 loopback bypass)', async () => {
      await expect(
        svc.processFileFromUrl('http://[::ffff:127.0.0.1]/file.pdf'),
      ).rejects.toThrow();
    });

    it('rejects fc00::/7 unique-local IPv6', async () => {
      await expect(
        svc.processFileFromUrl('http://[fc00::1]/file.pdf'),
      ).rejects.toThrow();
      await expect(
        svc.processFileFromUrl('http://[fd12:3456:789a::1]/file.pdf'),
      ).rejects.toThrow();
    });

    it('rejects fe80::/10 link-local IPv6', async () => {
      await expect(
        svc.processFileFromUrl('http://[fe80::1]/file.pdf'),
      ).rejects.toThrow();
    });

    it('rejects metadata.google.internal', async () => {
      await expect(
        svc.processFileFromUrl(
          'http://metadata.google.internal/computeMetadata/v1/file.pdf',
        ),
      ).rejects.toThrow();
    });

    it('rejects non-http/https schemes', async () => {
      await expect(svc.processFileFromUrl('ftp://example.com/x.pdf')).rejects.toThrow(
        /Invalid URI scheme/,
      );
      await expect(svc.processFileFromUrl('file:///etc/passwd')).rejects.toThrow(
        /Invalid URI scheme/,
      );
    });

    it('re-validates each redirect hop and rejects when one points to an internal address', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          redirectResponse('http://127.0.0.1/secret.pdf'),
        );
      await expect(
        svc.processFileFromUrl('http://example.com/file.pdf'),
      ).rejects.toThrow(/blocked internal address/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it(`rejects after ${MAX_REDIRECT_COUNT} redirects (too many redirects)`, async () => {
      // 7 redirects guarantees the loop exhausts its MAX_REDIRECT_COUNT+1
      // iterations while every response still says 3xx with location.
      for (let i = 0; i < 7; i++) {
        fetchSpy.mockResolvedValueOnce(
          redirectResponse(`http://safe-${i + 1}.test/file.pdf`),
        );
      }
      await expect(
        svc.processFileFromUrl('http://safe-0.test/file.pdf'),
      ).rejects.toThrow(/Too many redirects/);
      // Loop runs MAX_REDIRECT_COUNT+1 = 6 iterations before bailing.
      expect(fetchSpy).toHaveBeenCalledTimes(MAX_REDIRECT_COUNT + 1);
    });
  });

  describe('processAttachments — credit deduction', () => {
    it('calls creditSink.deductForFileProcessing only when aiCallsMade > 0', async () => {
      // Plain-text attachment goes through processDocument fast-path
      // (no AI call, no usage) — credit sink stays untouched.
      matrixDownloadContent.mockResolvedValue({
        data: Buffer.from('hello', 'utf-8'),
      });

      await svc.processAttachments(
        [makeAttachment({ filename: 'a.txt', mxcUri: 'mxc://h/a' })],
        ROOM_ID,
        USER_DID,
      );
      expect(creditSink.deductForFileProcessing).not.toHaveBeenCalled();

      // Image attachment triggers AI processing — sink must be called.
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      matrixDownloadContent.mockResolvedValueOnce({ data: pngHeader });
      fetchSpy.mockResolvedValueOnce(
        aiResponse('a cat', {
          prompt_tokens: 10,
          completion_tokens: 5,
          cost: 0.01,
        }),
      );

      await svc.processAttachments(
        [
          makeAttachment({
            filename: 'pic.png',
            mxcUri: 'mxc://h/pic',
            mimetype: 'image/png',
          }),
        ],
        ROOM_ID,
        USER_DID,
      );
      expect(creditSink.deductForFileProcessing).toHaveBeenCalledTimes(1);
      expect(creditSink.deductForFileProcessing).toHaveBeenCalledWith(
        USER_DID,
        expect.objectContaining({
          cost: 0.01,
          promptTokens: 10,
          completionTokens: 5,
        }),
      );
    });

    it('swallows creditSink errors and still returns successfully', async () => {
      creditSink.deductForFileProcessing.mockRejectedValue(
        new Error('billing down'),
      );
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      matrixDownloadContent.mockResolvedValue({ data: pngHeader });
      fetchSpy.mockResolvedValueOnce(
        aiResponse('photo', {
          prompt_tokens: 1,
          completion_tokens: 1,
          cost: 0.001,
        }),
      );

      const result = await svc.processAttachments(
        [
          makeAttachment({
            filename: 'a.png',
            mxcUri: 'mxc://h/a',
            mimetype: 'image/png',
          }),
        ],
        ROOM_ID,
        USER_DID,
      );

      expect(creditSink.deductForFileProcessing).toHaveBeenCalledTimes(1);
      expect(result.texts).toHaveLength(1);
    });

    it('skips credit deduction when userDid is undefined', async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      matrixDownloadContent.mockResolvedValue({ data: pngHeader });
      fetchSpy.mockResolvedValueOnce(
        aiResponse('photo', {
          prompt_tokens: 1,
          completion_tokens: 1,
          cost: 0.001,
        }),
      );

      await svc.processAttachments(
        [
          makeAttachment({
            filename: 'a.png',
            mxcUri: 'mxc://h/a',
            mimetype: 'image/png',
          }),
        ],
        ROOM_ID,
        undefined,
      );

      expect(creditSink.deductForFileProcessing).not.toHaveBeenCalled();
      expect(ucanService.createServiceInvocation).not.toHaveBeenCalled();
    });
  });

  describe('processAttachments — sandbox upload', () => {
    function svcWithSandbox(opts: {
      sandboxUrl?: string;
      invocation?: string | null;
    }): FileProcessingService {
      const ucan = {
        createServiceInvocation: vi
          .fn()
          .mockResolvedValue(opts.invocation ?? null),
      } satisfies Partial<UcanService>;
      ucanService = ucan;
      return new FileProcessingService(
        makeConfig({
          SANDBOX_MCP_URL: opts.sandboxUrl,
        }),
        ucan as unknown as UcanService,
        creditSink,
      );
    }

    it('returns undefined sandbox config when SANDBOX_MCP_URL is unset', async () => {
      svc = svcWithSandbox({ sandboxUrl: undefined });
      matrixDownloadContent.mockResolvedValue({
        data: Buffer.from('hi', 'utf-8'),
      });

      await svc.processAttachments(
        [makeAttachment({ mxcUri: 'mxc://h/a' })],
        ROOM_ID,
        USER_DID,
      );

      expect(ucanService.createServiceInvocation).not.toHaveBeenCalled();
    });

    it('returns undefined sandbox config when UCAN invocation is null', async () => {
      svc = svcWithSandbox({
        sandboxUrl: 'https://sandbox.test/mcp',
        invocation: null,
      });
      matrixDownloadContent.mockResolvedValue({
        data: Buffer.from('hi', 'utf-8'),
      });

      await svc.processAttachments(
        [makeAttachment({ mxcUri: 'mxc://h/a' })],
        ROOM_ID,
        USER_DID,
      );

      expect(ucanService.createServiceInvocation).toHaveBeenCalledTimes(1);
      // No fetch to /artifacts/upload happened — only the AI call path would
      // have fired fetch, and plain text doesn't trigger AI either.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns primary text even when sandbox upload fails after AI spend', async () => {
      svc = svcWithSandbox({
        sandboxUrl: 'https://sandbox.test/mcp',
        invocation: 'ucan-token',
      });
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      matrixDownloadContent.mockResolvedValue({ data: pngHeader });
      // 1st fetch: AI call (succeeds). 2nd fetch: sandbox upload (500).
      fetchSpy
        .mockResolvedValueOnce(
          aiResponse('a cat', {
            prompt_tokens: 1,
            completion_tokens: 1,
            cost: 0.01,
          }),
        )
        .mockResolvedValueOnce(
          new Response('boom', { status: 500 }),
        );

      const result = await svc.processAttachments(
        [
          makeAttachment({
            filename: 'pic.png',
            mxcUri: 'mxc://h/pic',
            mimetype: 'image/png',
          }),
        ],
        ROOM_ID,
        USER_DID,
      );

      expect(result.texts[0]).toContain('a cat');
      expect(result.texts[0]).toMatch(/sandbox upload failed/i);
    });

    it('soft-fails on analysis.md upload without dropping primary text', async () => {
      svc = svcWithSandbox({
        sandboxUrl: 'https://sandbox.test/mcp',
        invocation: 'ucan-token',
      });
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      matrixDownloadContent.mockResolvedValue({ data: pngHeader });
      // 1: AI call OK. 2: file upload OK. 3: analysis.md upload fails.
      fetchSpy
        .mockResolvedValueOnce(
          aiResponse('description here', {
            prompt_tokens: 1,
            completion_tokens: 1,
            cost: 0.01,
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ path: '/workspace/output/pic.png' }),
        )
        .mockResolvedValueOnce(
          new Response('analysis boom', { status: 500 }),
        );

      const result = await svc.processAttachments(
        [
          makeAttachment({
            filename: 'pic.png',
            mxcUri: 'mxc://h/pic',
            mimetype: 'image/png',
          }),
        ],
        ROOM_ID,
        USER_DID,
      );

      expect(result.texts[0]).toContain('description here');
      // File-saved marker present, no analysis-saved marker.
      expect(result.texts[0]).toContain('[File also saved to sandbox at');
      expect(result.texts[0]).not.toContain('Analysis saved to sandbox');
    });

    it('sanitizeSandboxPath strips .. segments and bad chars (via uploadToSandbox)', async () => {
      svc = svcWithSandbox({
        sandboxUrl: 'https://sandbox.test/mcp',
        invocation: 'ucan-token',
      });
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ path: '/workspace/output/clean.png' }),
      );

      await svc.uploadToSandbox(
        Buffer.from('data'),
        'pic name!@#.png',
        '/workspace/../etc/passwd',
        {
          sandboxMcpUrl: 'https://sandbox.test/mcp',
          authHeaders: { Authorization: 'Bearer x', 'X-Auth-Type': 'ucan' },
        },
        'image/png',
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0];
      expect(call[0]).toBe('https://sandbox.test/artifacts/upload');
      const init = call[1] as RequestInit;
      const body = init.body as FormData;
      const path = body.get('path');
      expect(typeof path).toBe('string');
      expect(path).toBe('/workspace/etc/passwd');
      const file = body.get('file');
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe('pic_name___.png');
    });
  });

  describe('verifyMagicBytes (via processFileFromEventId)', () => {
    it('throws when claimed image/png but bytes are PDF', async () => {
      const pdfBytes = Buffer.concat([
        Buffer.from('%PDF-1.7\n', 'utf-8'),
        Buffer.alloc(100, 0),
      ]);
      matrixGetEvent.mockResolvedValue({
        content: { url: 'mxc://h/evt', msgtype: 'm.image' },
      });
      matrixDownloadContent.mockResolvedValue({ data: pdfBytes });

      await expect(
        svc.processFileFromEventId(ROOM_ID, '$evt1', {
          filename: 'pic.png',
          mimetype: 'image/png',
        }),
      ).rejects.toThrow(/content mismatch/);
    });

    it('skips magic byte verification for plain-text mimetypes', async () => {
      // Bytes that would not match any known magic signature — for a plain
      // text mimetype the verifier short-circuits and processing still
      // succeeds end-to-end.
      const textBytes = Buffer.from('hello world', 'utf-8');
      matrixGetEvent.mockResolvedValue({
        content: { url: 'mxc://h/evt', msgtype: 'm.text' },
      });
      matrixDownloadContent.mockResolvedValue({ data: textBytes });

      const result = await svc.processFileFromEventId(ROOM_ID, '$evt1', {
        filename: 'notes.txt',
        mimetype: 'text/plain',
      });
      expect(result).toContain('hello world');
    });

    it('tolerates unrecognized magic bytes (no throw)', async () => {
      // Bytes that match no MAGIC_BYTES entry. Claimed PDF — the verifier
      // warns and returns without throwing; processDocument then handles it.
      const unknown = Buffer.alloc(128, 0);
      matrixGetEvent.mockResolvedValue({
        content: { url: 'mxc://h/evt', msgtype: 'm.file' },
      });
      matrixDownloadContent.mockResolvedValue({ data: unknown });
      // PDF parser will fail on these bytes, but the SUT then falls back to
      // the AI processor — stub the AI call so we don't blow up.
      loadFileFromBufferMock.mockRejectedValue(new Error('bad pdf'));
      fetchSpy.mockResolvedValueOnce(aiResponse('ok'));

      const result = await svc.processFileFromEventId(ROOM_ID, '$evt1', {
        filename: 'doc.pdf',
        mimetype: 'application/pdf',
      });
      expect(result).toContain('ok');
    });
  });

  describe('downloadFromUrl (via downloadAndProcessFile)', () => {
    it('aborts the request after MATRIX_DOWNLOAD_TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      // Fetch hangs until the abort signal fires.
      fetchSpy.mockImplementation((_url, init) => {
        const signal = (init as RequestInit | undefined)?.signal;
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => {
            reject(
              Object.assign(new Error('The operation was aborted.'), {
                name: 'AbortError',
              }),
            );
          });
        });
      });

      const promise = svc.downloadAndProcessFile({
        url: 'https://example.com/file.pdf',
      });
      // Capture the rejection assertion as a pending promise — DON'T await
      // it yet. Advance fake timers so the AbortSignal fires, then await
      // the expectation. Awaiting first would deadlock against the fake
      // clock (the timeout never fires). The lint rule sees only the
      // capture, not the deferred await two lines down.
      // eslint-disable-next-line vitest/valid-expect
      const expectation = expect(promise).rejects.toThrow(/aborted/i);
      await vi.advanceTimersByTimeAsync(MATRIX_DOWNLOAD_TIMEOUT_MS + 1);
      await expectation;
    });

    it('aborts mid-stream when the reader exceeds MAX_FILE_SIZE', async () => {
      // Stream more than MAX_FILE_SIZE in chunks. The reader's running total
      // must trip the size check and reject before completing.
      const chunkSize = 5 * 1024 * 1024;
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < 6; i++) {
        chunks.push(new Uint8Array(chunkSize));
      }
      fetchSpy.mockResolvedValueOnce(
        streamResponse(chunks, {
          headers: { 'content-type': 'application/pdf' },
        }),
      );

      await expect(
        svc.downloadAndProcessFile({
          url: 'https://example.com/file.pdf',
        }),
      ).rejects.toThrow(/exceeds maximum size/);
    });

    it('rejects when content-length header exceeds MAX_FILE_SIZE', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('ignored', {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(MAX_FILE_SIZE + 1),
          },
        }),
      );

      await expect(
        svc.downloadAndProcessFile({
          url: 'https://example.com/big.pdf',
        }),
      ).rejects.toThrow(/File too large/);
    });
  });
});
