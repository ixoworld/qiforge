import type * as IxoCommon from '@ixo/common';
import { type SessionManagerService } from '@ixo/common';
import { SqliteSaver } from '@ixo/sqlite-saver';
import type { Response } from 'express';
import { AIMessage, HumanMessage, type BaseMessage } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { makeConfig } from '../../testing/nest-doubles.js';
import { type BatchInvoker } from './batch-invoker.js';
import {
  type AttachmentDto,
  type SendMessagePayload,
} from './dto/send-message.dto.js';
import { type FileProcessingService } from './file-processing.service.js';
import { type MatrixListenerBridge } from './matrix-listener-bridge.js';
import {
  MessagesService,
  type SendMessageRequest,
} from './messages.service.js';
import { type PostMessageSyncer } from './post-message-syncer.js';
import { type RequestPreparer } from './request-preparer.js';
import {
  type SseStreamRunner,
  type StreamRunInput,
} from './sse-stream-runner.js';
import { FakeResponse } from './__test-fixtures__/fake-response.js';
import {
  makeCheckpointSync,
  makePrepared,
  makeSessionManagerStub,
} from './__test-fixtures__/deps.js';

vi.mock('@ixo/sqlite-saver', () => ({
  SqliteSaver: {
    fromDatabase: vi.fn(() => ({ getTuple: vi.fn() })),
  },
}));

vi.mock('@ixo/common', async (importOriginal) => ({
  ...(await importOriginal<typeof IxoCommon>()),
  transformGraphStateMessageToListMessageResponse: vi.fn(
    (messages: BaseMessage[]) => ({ messages, total: messages.length }),
  ),
}));

const USER_DID = 'did:ixo:user-1';
const SESSION_ID = 'sess-1';
const HOME_SERVER = 'home.server';
const ROOM_ID = '!room:home';

function makeSendPayload(
  overrides: Partial<SendMessageRequest> = {},
): SendMessageRequest {
  const base: SendMessagePayload = {
    did: USER_DID,
    sessionId: SESSION_ID,
    message: 'hello',
    homeServer: HOME_SERVER,
  };
  return { ...base, ...overrides };
}

interface ServiceUnderTest {
  svc: MessagesService;
  preparer: {
    prepare: ReturnType<typeof vi.fn>;
    validateSessionId: ReturnType<typeof vi.fn>;
  };
  streamer: { run: ReturnType<typeof vi.fn> };
  batchInvoker: { invoke: ReturnType<typeof vi.fn> };
  fileProcessing: {
    processAttachments: ReturnType<typeof vi.fn>;
    loadAttachmentBytes: ReturnType<typeof vi.fn>;
    archiveAttachmentInBackground: ReturnType<typeof vi.fn>;
  };
  checkpointSync: ReturnType<typeof makeCheckpointSync>;
  postSync: { run: ReturnType<typeof vi.fn> };
  matrixBridge: { setDeliverHandler: ReturnType<typeof vi.fn> };
  sessions: ReturnType<typeof makeSessionManagerStub>;
}

function build(): ServiceUnderTest {
  const preparer = {
    prepare: vi.fn().mockResolvedValue(makePrepared()),
    validateSessionId: vi.fn(),
  };
  const streamer = { run: vi.fn().mockResolvedValue(undefined) };
  const batchInvoker = {
    invoke: vi.fn().mockResolvedValue({
      message: { type: 'ai', content: 'reply', id: 'msg-1' },
      sessionId: SESSION_ID,
    }),
  };
  const fileProcessing = {
    processAttachments: vi.fn(),
    loadAttachmentBytes: vi.fn(),
    archiveAttachmentInBackground: vi.fn(),
  };
  const checkpointSync = makeCheckpointSync();
  const postSync = { run: vi.fn() };
  const matrixBridge = { setDeliverHandler: vi.fn() };
  const sessions = makeSessionManagerStub();
  const config = makeConfig({});
  const svc = new MessagesService(
    preparer as unknown as RequestPreparer,
    streamer as unknown as SseStreamRunner,
    batchInvoker as unknown as BatchInvoker,
    fileProcessing as unknown as FileProcessingService,
    checkpointSync as unknown as UserMatrixSqliteSyncService,
    postSync as unknown as PostMessageSyncer,
    matrixBridge as unknown as MatrixListenerBridge,
    sessions as unknown as SessionManagerService,
    config,
  );
  return {
    svc,
    preparer,
    streamer,
    batchInvoker,
    fileProcessing,
    checkpointSync,
    postSync,
    matrixBridge,
    sessions,
  };
}

describe('MessagesService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listMessages', () => {
    it('validates sessionId via preparer.validateSessionId', async () => {
      const { svc, preparer } = build();
      preparer.validateSessionId.mockImplementation(() => {
        throw new Error('bad session');
      });

      await expect(
        svc.listMessages({ did: USER_DID, sessionId: SESSION_ID }),
      ).rejects.toThrow('bad session');
      expect(preparer.validateSessionId).toHaveBeenCalledWith(
        SESSION_ID,
        USER_DID,
      );
    });

    it('calls markUserActive once and markUserInactive in finally (success path)', async () => {
      const { svc, checkpointSync } = build();
      vi.mocked(SqliteSaver.fromDatabase).mockReturnValueOnce({
        getTuple: vi.fn().mockResolvedValue({
          checkpoint: { channel_values: { messages: [] } },
        }),
      } as unknown as ReturnType<typeof SqliteSaver.fromDatabase>);

      await svc.listMessages({ did: USER_DID, sessionId: SESSION_ID });

      expect(checkpointSync.markUserActive).toHaveBeenCalledTimes(1);
      expect(checkpointSync.markUserActive).toHaveBeenCalledWith(USER_DID);
      expect(checkpointSync.markUserInactive).toHaveBeenCalledTimes(1);
      expect(checkpointSync.markUserInactive).toHaveBeenCalledWith(USER_DID);
    });

    it('calls markUserInactive in finally when getUserDatabase throws', async () => {
      const { svc, checkpointSync } = build();
      checkpointSync.getUserDatabase.mockRejectedValueOnce(
        new Error('db gone'),
      );

      await expect(
        svc.listMessages({ did: USER_DID, sessionId: SESSION_ID }),
      ).rejects.toThrow('db gone');
      expect(checkpointSync.markUserActive).toHaveBeenCalledTimes(1);
      expect(checkpointSync.markUserInactive).toHaveBeenCalledTimes(1);
    });

    it('reads tuple via SqliteSaver.fromDatabase and returns transformed messages', async () => {
      const { svc, checkpointSync } = build();
      const db = { handle: 'db-handle' };
      checkpointSync.getUserDatabase.mockResolvedValueOnce(db);
      const messages = [new HumanMessage('hi')];
      const getTuple = vi.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages } },
      });
      vi.mocked(SqliteSaver.fromDatabase).mockReturnValueOnce({
        getTuple,
      } as unknown as ReturnType<typeof SqliteSaver.fromDatabase>);

      const result = await svc.listMessages({
        did: USER_DID,
        sessionId: SESSION_ID,
      });

      expect(SqliteSaver.fromDatabase).toHaveBeenCalledWith(db);
      expect(getTuple).toHaveBeenCalledWith({
        configurable: { thread_id: SESSION_ID },
      });
      expect(result).toEqual({ messages, total: 1 });
    });

    it('returns empty messages list when checkpoint has no channel_values.messages', async () => {
      const { svc } = build();
      vi.mocked(SqliteSaver.fromDatabase).mockReturnValueOnce({
        getTuple: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<typeof SqliteSaver.fromDatabase>);

      const result = await svc.listMessages({
        did: USER_DID,
        sessionId: SESSION_ID,
      });

      expect(result).toEqual({ messages: [], total: 0 });
    });
  });

  describe('sendMessage (streaming branch)', () => {
    it('delegates to SseStreamRunner.run when stream=true and res present', async () => {
      const { svc, streamer, batchInvoker } = build();
      const res = new FakeResponse();
      const params = makeSendPayload({
        stream: true,
        res: res as unknown as Response,
      });

      const result = await svc.sendMessage(params);

      expect(streamer.run).toHaveBeenCalledTimes(1);
      expect(batchInvoker.invoke).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
      const runArg = streamer.run.mock.calls[0]![0] as StreamRunInput;
      expect(runArg.res).toBe(res);
      expect(runArg.payload.message).toBe('hello');
    });

    it('flushes SSE headers + instant thinking ack BEFORE any pre-flight work', async () => {
      const { svc, preparer } = build();
      const res = new FakeResponse();
      let headersSentWhenPrepareRan: boolean | undefined;
      let writesWhenPrepareRan = 0;
      preparer.prepare.mockImplementation(async () => {
        headersSentWhenPrepareRan = res.headersSent;
        writesWhenPrepareRan = res.writes.length;
        return makePrepared();
      });
      const params = makeSendPayload({
        stream: true,
        res: res as unknown as Response,
      });

      await svc.sendMessage(params);

      expect(headersSentWhenPrepareRan).toBe(true);
      expect(writesWhenPrepareRan).toBeGreaterThanOrEqual(1);
      expect(res.writes[0]).toContain('event: reasoning');
      // The resolved requestId is on the headers AND threaded into prepare —
      // header and runnableConfig must agree.
      const requestId = res.setHeaders['X-Request-Id'];
      expect(requestId).toBeTruthy();
      const prepareArg = preparer.prepare.mock.calls[0]![0] as {
        requestId?: string;
      };
      expect(prepareArg.requestId).toBe(requestId);
    });

    it('turns a pre-flight failure into SSE error + done instead of throwing (stream path)', async () => {
      const { svc, preparer, streamer } = build();
      const res = new FakeResponse();
      preparer.prepare.mockRejectedValue(new Error('Session not found'));
      const params = makeSendPayload({
        stream: true,
        res: res as unknown as Response,
      });

      const result = await svc.sendMessage(params);

      expect(result).toBeUndefined();
      expect(streamer.run).not.toHaveBeenCalled();
      const wire = res.writes.join('');
      expect(wire).toContain('event: error');
      expect(wire).toContain('Session not found');
      expect(wire).toContain('event: done');
      expect(res.writableEnded).toBe(true);
    });

    it('increments active count once on entry with matching decrement in finally', async () => {
      const { svc, checkpointSync } = build();
      const res = new FakeResponse();
      const params = makeSendPayload({
        stream: true,
        res: res as unknown as Response,
      });

      await svc.sendMessage(params);

      expect(checkpointSync.markUserActive).toHaveBeenCalledTimes(1);
      expect(checkpointSync.markUserActive).toHaveBeenNthCalledWith(
        1,
        USER_DID,
      );
      expect(checkpointSync.markUserInactive).toHaveBeenCalledTimes(1);
      expect(checkpointSync.markUserInactive).toHaveBeenCalledWith(USER_DID);
    });

    it('skips Matrix user-text replay when msgFromMatrixRoom=true', async () => {
      const { svc, sessions } = build();
      const res = new FakeResponse();
      const params = makeSendPayload({
        stream: true,
        res: res as unknown as Response,
        msgFromMatrixRoom: true,
      });

      await svc.sendMessage(params);

      expect(sessions.matrixManger.sendMessage).not.toHaveBeenCalled();
    });

    it('fires Matrix user-text replay when msgFromMatrixRoom=false (not awaited)', async () => {
      const { svc, sessions } = build();
      const res = new FakeResponse();
      const params = makeSendPayload({
        stream: true,
        res: res as unknown as Response,
      });

      await svc.sendMessage(params);

      expect(sessions.matrixManger.sendMessage).toHaveBeenCalledWith({
        message: 'hello',
        roomId: ROOM_ID,
        threadId: SESSION_ID,
        isOracleAdmin: false,
      });
    });

    it('logs but does not throw when Matrix user-replay rejects', async () => {
      const { svc, sessions } = build();
      const res = new FakeResponse();
      sessions.matrixManger.sendMessage.mockRejectedValueOnce(
        new Error('matrix offline'),
      );
      const params = makeSendPayload({
        stream: true,
        res: res as unknown as Response,
      });

      await expect(svc.sendMessage(params)).resolves.toBeUndefined();
      // Drain the .catch on the fire-and-forget so the rejection lands.
      await vi.waitFor(() =>
        expect(sessions.matrixManger.sendMessage).toHaveBeenCalled(),
      );
    });

    it('onComplete callback fires AI replay to Matrix when !msgFromMatrixRoom', async () => {
      const { svc, sessions, streamer } = build();
      const res = new FakeResponse();
      const params = makeSendPayload({
        stream: true,
        res: res as unknown as Response,
      });

      await svc.sendMessage(params);

      const runArg = streamer.run.mock.calls[0]![0] as StreamRunInput;
      sessions.matrixManger.sendMessage.mockClear();
      runArg.onComplete!('assistant reply text');

      expect(sessions.matrixManger.sendMessage).toHaveBeenCalledWith({
        message: 'assistant reply text',
        roomId: ROOM_ID,
        threadId: SESSION_ID,
        isOracleAdmin: true,
      });
    });

    it('onComplete fires firePostSync which calls markUserActive (handoff to PostMessageSyncer)', async () => {
      const { svc, streamer, checkpointSync, postSync } = build();
      const res = new FakeResponse();
      const params = makeSendPayload({
        stream: true,
        res: res as unknown as Response,
      });

      await svc.sendMessage(params);

      const runArg = streamer.run.mock.calls[0]![0] as StreamRunInput;
      checkpointSync.markUserActive.mockClear();
      runArg.onComplete!('assistant reply');

      expect(checkpointSync.markUserActive).toHaveBeenCalledTimes(1);
      expect(checkpointSync.markUserActive).toHaveBeenCalledWith(USER_DID);
      expect(postSync.run).toHaveBeenCalledTimes(1);
      expect(postSync.run).toHaveBeenCalledWith(
        expect.objectContaining({
          did: USER_DID,
          sessionId: SESSION_ID,
          roomId: ROOM_ID,
        }),
      );
    });

    it('onComplete skips AI replay when assistantText is empty', async () => {
      const { svc, sessions, streamer } = build();
      const res = new FakeResponse();
      const params = makeSendPayload({
        stream: true,
        res: res as unknown as Response,
      });

      await svc.sendMessage(params);

      const runArg = streamer.run.mock.calls[0]![0] as StreamRunInput;
      sessions.matrixManger.sendMessage.mockClear();
      runArg.onComplete!('');

      expect(sessions.matrixManger.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage (non-stream branch)', () => {
    it('invokes BatchInvoker.invoke when stream=false', async () => {
      const { svc, batchInvoker, streamer } = build();

      await svc.sendMessage(makeSendPayload({ stream: false }));

      expect(batchInvoker.invoke).toHaveBeenCalledTimes(1);
      expect(streamer.run).not.toHaveBeenCalled();
    });

    it('fires AI Matrix replay with result.message.content when !msgFromMatrixRoom', async () => {
      const { svc, sessions, batchInvoker } = build();
      batchInvoker.invoke.mockResolvedValueOnce({
        message: { type: 'ai', content: 'batch reply', id: 'm1' },
        sessionId: SESSION_ID,
      });

      await svc.sendMessage(makeSendPayload({ stream: false }));

      // The user replay fires first, then the AI replay.
      expect(sessions.matrixManger.sendMessage).toHaveBeenNthCalledWith(2, {
        message: 'batch reply',
        roomId: ROOM_ID,
        threadId: SESSION_ID,
        isOracleAdmin: true,
      });
    });

    it('fires firePostSync after batch reply', async () => {
      const { svc, postSync, checkpointSync } = build();
      checkpointSync.markUserActive.mockClear();

      await svc.sendMessage(makeSendPayload({ stream: false }));

      expect(postSync.run).toHaveBeenCalledTimes(1);
      // markUserActive: 1 on entry + 1 from firePostSync.
      expect(checkpointSync.markUserActive).toHaveBeenCalledTimes(2);
    });

    it('returns BatchInvokeResult', async () => {
      const { svc, batchInvoker } = build();
      const expected = {
        message: { type: 'ai', content: 'reply', id: 'mid' },
        sessionId: SESSION_ID,
      };
      batchInvoker.invoke.mockResolvedValueOnce(expected);

      const result = await svc.sendMessage(makeSendPayload({ stream: false }));

      expect(result).toBe(expected);
    });
  });

  describe('sendMessage (attachments)', () => {
    const attachment: AttachmentDto = {
      eventId: '$evt-1',
      filename: 'report.pdf',
      mimetype: 'application/pdf',
    };

    it('calls fileProcessing.processAttachments when attachments present', async () => {
      const { svc, fileProcessing, batchInvoker } = build();
      fileProcessing.processAttachments.mockResolvedValueOnce({
        texts: ['extracted text'],
        metadata: [{ eventId: '$evt-1', filename: 'report.pdf' }],
        totalUsage: { cost: 0, promptTokens: 0, completionTokens: 0 },
      });

      await svc.sendMessage(
        // A text-only model (GLM) routes every attachment to extraction —
        // this test pins the extract path deliberately.
        makeSendPayload({
          stream: false,
          attachments: [attachment],
          model: 'z-ai/glm-5.2',
        }),
      );

      expect(fileProcessing.processAttachments).toHaveBeenCalledWith(
        [attachment],
        ROOM_ID,
        USER_DID,
      );
      const invokeArg = batchInvoker.invoke.mock.calls[0]![0] as {
        inputMessages: BaseMessage[];
      };
      // 1 HumanMessage + 1 AIMessage per attachment.
      expect(invokeArg.inputMessages).toHaveLength(2);
      expect(invokeArg.inputMessages[0]).toBeInstanceOf(HumanMessage);
      expect(invokeArg.inputMessages[1]).toBeInstanceOf(AIMessage);
    });

    it('assembles AIMessage per attachment with eventId or mxcUri source ref', async () => {
      const { svc, fileProcessing, batchInvoker } = build();
      const urlAttachment: AttachmentDto = {
        mxcUri: 'mxc://home/abc',
        filename: 'pic.png',
        mimetype: 'image/png',
      };
      fileProcessing.processAttachments.mockResolvedValueOnce({
        texts: ['from event', 'from url'],
        metadata: [
          { eventId: '$evt-1', filename: 'report.pdf' },
          { mxcUri: 'mxc://home/abc', filename: 'pic.png' },
        ],
        totalUsage: { cost: 0, promptTokens: 0, completionTokens: 0 },
      });

      await svc.sendMessage(
        makeSendPayload({
          stream: false,
          attachments: [attachment, urlAttachment],
          model: 'z-ai/glm-5.2',
        }),
      );

      const invokeArg = batchInvoker.invoke.mock.calls[0]![0] as {
        inputMessages: BaseMessage[];
      };
      expect(invokeArg.inputMessages).toHaveLength(3);
      const eventBodied = invokeArg.inputMessages[1]!;
      const urlBodied = invokeArg.inputMessages[2]!;
      expect(String(eventBodied.content)).toContain(
        '[source: eventId="$evt-1"]',
      );
      expect(String(eventBodied.content)).toContain('from event');
      expect(String(urlBodied.content)).toContain(
        '[source: url="mxc://home/abc"]',
      );
      expect(String(urlBodied.content)).toContain('from url');
    });

    it('sends an image NATIVELY (no extraction) when the model supports it', async () => {
      const { svc, fileProcessing, batchInvoker } = build();
      const imageAttachment: AttachmentDto = {
        eventId: '$img-1',
        filename: 'photo.png',
        mimetype: 'image/png',
      };
      fileProcessing.loadAttachmentBytes.mockResolvedValueOnce({
        buffer: Buffer.from('png-bytes'),
        mimetype: 'image/png',
      });

      await svc.sendMessage(
        // No model → default (GPT-5.4 Nano), which accepts images natively.
        makeSendPayload({ stream: false, attachments: [imageAttachment] }),
      );

      // The old flow must NOT run for a natively-sent image.
      expect(fileProcessing.processAttachments).not.toHaveBeenCalled();
      expect(fileProcessing.loadAttachmentBytes).toHaveBeenCalledWith(
        imageAttachment,
        ROOM_ID,
      );
      // The original is still archived to the sandbox, off the hot path.
      expect(fileProcessing.archiveAttachmentInBackground).toHaveBeenCalledWith(
        imageAttachment,
        Buffer.from('png-bytes'),
        USER_DID,
      );

      const invokeArg = batchInvoker.invoke.mock.calls[0]![0] as {
        inputMessages: BaseMessage[];
      };
      // Single multimodal HumanMessage — no injected AIMessage.
      expect(invokeArg.inputMessages).toHaveLength(1);
      const human = invokeArg.inputMessages[0]!;
      expect(human).toBeInstanceOf(HumanMessage);
      const content = human.content as Array<Record<string, unknown>>;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0]).toEqual({ type: 'text', text: 'hello' });
      expect(content[1]).toMatchObject({
        type: 'image',
        source_type: 'base64',
        mime_type: 'image/png',
        data: Buffer.from('png-bytes').toString('base64'),
      });
      // Attachment metadata rides on the human message for the client.
      expect(human.additional_kwargs.attachment).toMatchObject({
        filename: 'photo.png',
        mimetype: 'image/png',
        eventId: '$img-1',
      });
    });

    it('falls back to extraction when the native download fails', async () => {
      const { svc, fileProcessing, batchInvoker } = build();
      const imageAttachment: AttachmentDto = {
        eventId: '$img-2',
        filename: 'broken.png',
        mimetype: 'image/png',
      };
      fileProcessing.loadAttachmentBytes.mockRejectedValueOnce(
        new Error('download failed'),
      );
      fileProcessing.processAttachments.mockResolvedValueOnce({
        texts: ['described image'],
        metadata: [{ eventId: '$img-2', filename: 'broken.png' }],
        totalUsage: { cost: 0, promptTokens: 0, completionTokens: 0 },
      });

      await svc.sendMessage(
        makeSendPayload({ stream: false, attachments: [imageAttachment] }),
      );

      // Failed native load → that file goes through the extract pipeline.
      expect(fileProcessing.processAttachments).toHaveBeenCalledWith(
        [imageAttachment],
        ROOM_ID,
        USER_DID,
      );
      const invokeArg = batchInvoker.invoke.mock.calls[0]![0] as {
        inputMessages: BaseMessage[];
      };
      expect(invokeArg.inputMessages).toHaveLength(2);
      // Human content stays a plain string — nothing was sent natively.
      expect(typeof invokeArg.inputMessages[0]!.content).toBe('string');
    });
  });

  describe('abortRequest', () => {
    it('returns false when no controller registered for sessionId', () => {
      const { svc } = build();
      expect(svc.abortRequest('unknown-sess')).toBe(false);
    });

    it('calls controller.abort() and removes from map when present, returns true', async () => {
      const { svc, streamer } = build();
      const res = new FakeResponse();
      let observedAbort = false;
      // Capture the controller MessagesService passes into streamer.run.
      streamer.run.mockImplementationOnce(async (input: StreamRunInput) => {
        const ctrl = new AbortController();
        ctrl.signal.addEventListener('abort', () => {
          observedAbort = true;
        });
        input.abortControllers.set(input.prepared.sessionId, ctrl);
        // While streaming is "in flight" the entry exists.
      });
      await svc.sendMessage(
        makeSendPayload({ stream: true, res: res as unknown as Response }),
      );

      const result = svc.abortRequest(SESSION_ID);

      expect(result).toBe(true);
      expect(observedAbort).toBe(true);
      // Second abort lands no controller.
      expect(svc.abortRequest(SESSION_ID)).toBe(false);
    });
  });

  describe('onModuleInit', () => {
    it('registers a deliverHandler on matrixBridge', () => {
      const { svc, matrixBridge } = build();
      svc.onModuleInit();

      expect(matrixBridge.setDeliverHandler).toHaveBeenCalledTimes(1);
      expect(matrixBridge.setDeliverHandler.mock.calls[0]![0]).toBeTypeOf(
        'function',
      );
    });

    it('registered handler invokes sendMessage with clientType=matrix and msgFromMatrixRoom=true', async () => {
      const { svc, matrixBridge, batchInvoker, sessions } = build();
      svc.onModuleInit();
      const handler = matrixBridge.setDeliverHandler.mock
        .calls[0]![0] as (msg: {
        did: string;
        message: string;
        threadId: string;
        langchainThreadId?: string;
        roomId: string;
        homeServer?: string;
        attachments?: AttachmentDto[];
      }) => Promise<unknown>;

      await handler({
        did: USER_DID,
        message: 'from-matrix',
        threadId: SESSION_ID,
        langchainThreadId: 'lc-thread-1',
        roomId: ROOM_ID,
        homeServer: HOME_SERVER,
      });

      expect(batchInvoker.invoke).toHaveBeenCalledTimes(1);
      const invokeArg = batchInvoker.invoke.mock.calls[0]![0] as {
        payload: SendMessageRequest;
      };
      expect(invokeArg.payload.clientType).toBe('matrix');
      expect(invokeArg.payload.msgFromMatrixRoom).toBe(true);
      expect(invokeArg.payload.message).toBe('from-matrix');
      expect(invokeArg.payload.overrideLangchainThreadId).toBe('lc-thread-1');
      // msgFromMatrixRoom=true must SHORT-CIRCUIT the user/AI Matrix replay
      // — otherwise we'd echo the user's own Matrix message back into the room.
      expect(sessions.matrixManger.sendMessage).not.toHaveBeenCalled();
    });
  });
});
