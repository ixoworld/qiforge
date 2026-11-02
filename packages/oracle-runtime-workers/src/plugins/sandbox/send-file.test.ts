import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createNoopAmbient } from '../../core/runtime-context';
import { REPLY_FILE_URL_MAX } from '../../delivery/schema';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { wrapPluginTool } from '../../core/wrap-plugin-tool';
import type { Logger, RuntimeContext } from '../../plugin-api/types';
import {
  buildSendFileTool,
  deliveredFilename,
  FILE_SAFETY_NOTE,
  fileMimetype,
  SEND_FILE_TOOL,
  sentFile,
  stripArtifactUrls,
} from './send-file';

const SIGNED =
  'https://r2.example/sandbox/output/report.docx?X-Amz-Signature=deadbeef&X-Amz-Expires=10800';
const PRESIGNED = JSON.stringify({
  previewUrl: `${SIGNED}&disposition=inline`,
  downloadUrl: SIGNED,
  url: SIGNED,
  path: '/output/report.docx',
  expiresIn: 10_800,
});

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const record = (message: unknown): void => {
    lines.push(String(message));
  };
  return { lines, log: record, warn: record, error: record, debug: record };
}

function contextWith(logger: Logger): RuntimeContext {
  return { ...makeRuntimeContext(), logger, toolCallId: 'call-1' };
}

async function callTool(
  invoke: (input: unknown) => Promise<unknown>,
  args: unknown,
  logger: Logger = recordingLogger(),
): Promise<unknown> {
  return buildSendFileTool({ invoke }, true).handler(args, contextWith(logger));
}

describe('deliveredFilename', () => {
  it('takes the last path segment and keeps the extension', () => {
    expect(deliveredFilename('/output/q3/report.docx')).toBe('report.docx');
    expect(deliveredFilename('/workspace/data/output/a b.pdf')).toBe('a b.pdf');
  });

  it('removes control, bidi, zero-width and reserved characters', () => {
    expect(deliveredFilename('/output/re‮port​\n"x".docx')).toBe(
      'reportx.docx',
    );
    expect(deliveredFilename('/output/a<b>:c|d*e?.pdf')).toBe('abcde.pdf');
    expect(deliveredFilename('/output/back\\slash.pdf')).toBe('slash.pdf');
  });

  it('never delivers a hidden or empty name', () => {
    expect(deliveredFilename('/output/.env')).toBe('env');
    expect(deliveredFilename('/output/...')).toBe('file');
    expect(deliveredFilename('/')).toBe('file');
  });

  it('cuts a long name and keeps its extension', () => {
    const name = deliveredFilename(`/output/${'é'.repeat(300)}.docx`);
    expect(Array.from(name)).toHaveLength(200);
    expect(name.endsWith('.docx')).toBe(true);
  });
});

describe('fileMimetype', () => {
  it('maps the allow-list, whatever the case of the extension', () => {
    expect(fileMimetype('r.PDF')).toBe('application/pdf');
    expect(fileMimetype('r.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(fileMimetype('r.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(fileMimetype('r.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(fileMimetype('r.txt')).toBe('text/plain');
    expect(fileMimetype('r.jpg')).toBe('image/jpeg');
    expect(fileMimetype('r.jpeg')).toBe('image/jpeg');
    expect(fileMimetype('r.png')).toBe('image/png');
    expect(fileMimetype('r.md')).toBe('text/markdown');
    expect(fileMimetype('r.csv')).toBe('text/csv');
  });

  it('has no type for anything else, the legacy Office formats included', () => {
    for (const name of [
      'a.doc',
      'a.xls',
      'a.ppt',
      'a.exe',
      'a.zip',
      'a.html',
      'a.json',
      'a.mp4',
      'noext',
      'a.',
    ])
      expect(fileMimetype(name)).toBeUndefined();
    // Object.prototype keys are not extensions.
    expect(fileMimetype('a.constructor')).toBeUndefined();
  });
});

describe('stripArtifactUrls', () => {
  const lookup = {
    previewUrl: SIGNED,
    downloadUrl: SIGNED,
    url: SIGNED,
    path: '/output/report.docx',
    filename: 'report.docx',
    cid: 'bafy1',
    tags: ['a', SIGNED],
    file_type: 'application/pdf',
    uploaded_at: '2026-11-02 10:00:00',
    expiresIn: 10_800,
    signedLink: SIGNED,
    nested: { previewUrl: null, other: 'kept' },
  };
  const metadata = {
    path: '/output/report.docx',
    filename: 'report.docx',
    cid: 'bafy1',
    tags: ['a'],
    file_type: 'application/pdf',
    uploaded_at: '2026-11-02 10:00:00',
    nested: { other: 'kept' },
  };

  it('strips the JSON text the MCP adapter returns, keeping it JSON text', () => {
    const out = stripArtifactUrls(JSON.stringify(lookup));
    expect(typeof out).toBe('string');
    expect(JSON.parse(out as string)).toEqual(metadata);
  });

  it('strips an object, a content block and a list of blocks', () => {
    expect(stripArtifactUrls(lookup)).toEqual(metadata);
    const block = {
      type: 'text',
      text: JSON.stringify(lookup),
      structuredContent: { url: SIGNED, path: '/output/report.docx' },
    };
    const stripped = stripArtifactUrls(block) as typeof block;
    expect(JSON.parse(stripped.text)).toEqual(metadata);
    expect(stripped.structuredContent).toEqual({
      path: '/output/report.docx',
    });
    const [first] = stripArtifactUrls([block]) as (typeof block)[];
    expect(JSON.stringify(first)).not.toContain('X-Amz-Signature');
  });

  it('keeps a list of artifacts and its cursor', () => {
    const list = {
      userAddress: 'ixo1user',
      artifacts: [{ path: '/output/a.pdf', size: 3, url: SIGNED }],
      nextCursor: null,
    };
    expect(stripArtifactUrls(JSON.stringify(list))).toBe(
      JSON.stringify(
        {
          userAddress: 'ixo1user',
          artifacts: [{ path: '/output/a.pdf', size: 3 }],
          nextCursor: null,
        },
        null,
        2,
      ),
    );
  });

  it('never passes on a result it cannot read', () => {
    const out = stripArtifactUrls(`the file is at ${SIGNED}`);
    expect(out).not.toContain('X-Amz-Signature');
    expect(JSON.parse(out as string)).toEqual({
      error: 'The result could not be read.',
    });
  });
});

describe('send_file', () => {
  it('asks for the path and hands the plan the link the model never sees', async () => {
    const invoke = vi.fn(async () => PRESIGNED);
    const now = Date.parse('2026-11-02T10:00:00.000Z');
    vi.useFakeTimers({ now });
    const message = await callTool(invoke, {
      path: '/output/report.docx',
      caption: 'The Q3 report',
    }).finally(() => vi.useRealTimers());

    expect(invoke).toHaveBeenCalledWith({ path: '/output/report.docx' });
    expect(ToolMessage.isInstance(message)).toBe(true);
    const tool = message as ToolMessage;
    expect(tool.tool_call_id).toBe('call-1');
    expect(tool.name).toBe(SEND_FILE_TOOL);
    expect(JSON.stringify(tool.content)).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(tool.content)).not.toContain('r2.example');
    expect(JSON.parse(tool.content as string)).toEqual({
      ok: true,
      filename: 'report.docx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      delivery:
        'Goes out with your reply, after the gateway has checked the file. Do not paste a link, and do not state that it is attached or delivered.',
    });
    const file = {
      url: SIGNED,
      filename: 'report.docx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      caption: 'The Q3 report',
      expiresAt: '2026-11-02T13:00:00.000Z',
    };
    expect(tool.artifact).toEqual({ ...file, path: '/output/report.docx' });
    // `path` identifies the file inside the runtime and never reaches a plan.
    expect(sentFile(tool.artifact)).toEqual({
      path: '/output/report.docx',
      file,
    });
  });

  it('identifies the file by the path the store normalised', async () => {
    const message = (await callTool(async () => PRESIGNED, {
      path: '/workspace/data/output/report.docx',
    })) as ToolMessage;
    expect(sentFile(message.artifact)?.path).toBe('/output/report.docx');
    // An upstream that reports none falls back to what the model passed.
    const bare = (await callTool(async () => JSON.stringify({ url: SIGNED }), {
      path: '/output/a.pdf',
    })) as ToolMessage;
    expect(sentFile(bare.artifact)?.path).toBe('/output/a.pdf');
  });

  it('fails closed on a link a gateway would refuse, rather than sending it as text', async () => {
    const atLimit = `https://r2.example/${'a'.repeat(REPLY_FILE_URL_MAX - 19)}`;
    expect(atLimit).toHaveLength(REPLY_FILE_URL_MAX);
    const sent = await callTool(
      async () => JSON.stringify({ downloadUrl: atLimit }),
      { path: '/output/a.pdf' },
    );
    expect(ToolMessage.isInstance(sent)).toBe(true);
    const failed = {
      ok: false,
      error:
        'Could not prepare `/output/a.pdf` for sending. Try once more; if it fails again, tell the user the file could not be sent. Do not offer a link.',
    };
    for (const downloadUrl of [
      `${atLimit}a`,
      'https://user:secret@r2.example/o/a.pdf',
      'https://user@r2.example/o/a.pdf',
    ])
      expect(
        await callTool(async () => JSON.stringify({ downloadUrl }), {
          path: '/output/a.pdf',
        }),
      ).toEqual(failed);
  });

  it('reads the link from every shape the adapter hands over', async () => {
    const signed = JSON.parse(PRESIGNED) as Record<string, unknown>;
    for (const result of [
      signed,
      { type: 'text', text: PRESIGNED },
      [{ type: 'text', source_type: 'text', text: PRESIGNED }],
    ]) {
      const message = (await callTool(async () => result, {
        path: '/output/report.docx',
      })) as ToolMessage;
      expect(message.artifact).toMatchObject({ url: SIGNED });
    }
  });

  it('prefers the attachment link, falls back to `url`, and records a known size', async () => {
    const message = (await callTool(
      async () => JSON.stringify({ url: SIGNED, size: 2048 }),
      { path: '/output/a.csv' },
    )) as ToolMessage;
    expect(sentFile(message.artifact)?.file).toEqual({
      url: SIGNED,
      filename: 'a.csv',
      mimetype: 'text/csv',
      bytes: 2048,
    });
  });

  it('sends every allowed type', async () => {
    for (const [name, mimetype] of [
      ['a.pdf', 'application/pdf'],
      [
        'a.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      [
        'a.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
      [
        'a.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ],
      ['a.txt', 'text/plain'],
      ['a.csv', 'text/csv'],
      ['a.md', 'text/markdown'],
      ['a.markdown', 'text/markdown'],
      ['a.PNG', 'image/png'],
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpeg'],
    ]) {
      const message = await callTool(async () => PRESIGNED, {
        path: `/output/${name}`,
      });
      expect(ToolMessage.isInstance(message)).toBe(true);
      expect((message as ToolMessage).artifact).toMatchObject({
        filename: name,
        mimetype,
      });
    }
  });

  it('refuses any other type before signing, with an error the model can act on', async () => {
    const invoke = vi.fn(async () => PRESIGNED);
    const logger = recordingLogger();
    for (const name of ['setup.exe', 'bundle.zip', 'page.html', 'old.doc']) {
      expect(
        await callTool(invoke, { path: `/output/${name}` }, logger),
      ).toEqual({
        ok: false,
        error: `Cannot send \`/output/${name}\`. This chat can only receive PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), text, CSV, Markdown, PNG or JPEG files. Convert the file, or describe its contents instead.`,
      });
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(logger.lines).toContain(
      '[send_file] /output/setup.exe: unsupported type',
    );
  });

  it('gives the model a clear error when the file is not stored', async () => {
    const logger = recordingLogger();
    const thrown = await callTool(
      async () => {
        throw new Error(
          `MCP tool 'artifact_get_presigned_url' on server 'sandbox' returned an error: {"error":"Artifact not found at path: /output/nope.docx"}`,
        );
      },
      { path: '/output/nope.docx' },
      logger,
    );
    expect(ToolMessage.isInstance(thrown)).toBe(false);
    expect(thrown).toEqual({
      ok: false,
      error:
        'No stored file at `/output/nope.docx`. A file is stored once the sandbox call that wrote it under `/workspace/data/output/` has finished. Check the path with `artifact_list`, or write the file first, then call `send_file` again.',
    });
    expect(
      await callTool(
        async () => JSON.stringify({ error: 'Artifact not found' }),
        { path: '/output/nope.docx' },
      ),
    ).toEqual(thrown);
  });

  it('never repeats an upstream failure, which could quote a signed link', async () => {
    const leaky = `Failed to generate presigned URL: bad ${SIGNED}`;
    const expected = {
      ok: false,
      error:
        'Could not prepare `/output/a.pdf` for sending. Try once more; if it fails again, tell the user the file could not be sent. Do not offer a link.',
    };
    const logger = recordingLogger();
    const results = [
      await callTool(
        async () => {
          throw new Error(leaky);
        },
        { path: '/output/a.pdf' },
        logger,
      ),
      await callTool(
        async () => JSON.stringify({ error: leaky }),
        { path: '/output/a.pdf' },
        logger,
      ),
      // No usable link: plain http, a non-URL, or nothing at all.
      await callTool(
        async () => JSON.stringify({ downloadUrl: 'http://r2.example/x' }),
        { path: '/output/a.pdf' },
        logger,
      ),
      await callTool(async () => 'not json', { path: '/output/a.pdf' }, logger),
    ];
    for (const result of results) expect(result).toEqual(expected);
    expect(logger.lines.join('\n')).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(results)).not.toContain('X-Amz-Signature');
  });

  it('writes no signed link to any log line, on the way through the tool stack', async () => {
    const logger = recordingLogger();
    const consoleLines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          consoleLines.push(args.map(String).join(' '));
        }),
    );
    try {
      const wrapped = wrapPluginTool(
        buildSendFileTool({ invoke: async () => PRESIGNED }, true),
        {
          ambient: createNoopAmbient({ logger }),
          state: { messages: [], loadedPlugins: new Set<string>() },
          fallbackContext: {
            user: {
              did: 'did:ixo:user1',
              matrixUserId: '@did-ixo-user1:ixo.world',
              ucanDelegation: { raw: 'ucan' },
            },
            session: { id: 's', client: 'channel', requestId: 'r' },
          },
          resultCap: { capChars: 10, sessionId: 's' },
        },
      );
      const message = (await wrapped.invoke({
        type: 'tool_call',
        id: 'call-9',
        name: SEND_FILE_TOOL,
        args: { path: '/output/report.docx' },
      })) as ToolMessage;
      // The cap never turned the message into text: the link is still only
      // in the artifact.
      expect(message.tool_call_id).toBe('call-9');
      expect(JSON.stringify(message.content)).not.toContain('X-Amz-Signature');
      expect(message.artifact).toMatchObject({ url: SIGNED });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const everything = [...logger.lines, ...consoleLines].join('\n');
    expect(everything).not.toContain('X-Amz-Signature');
    expect(everything).not.toContain('r2.example');
  });

  it('promises an attachment only where the surface delivers one', () => {
    const invoke = async (): Promise<string> => PRESIGNED;
    const chat = buildSendFileTool({ invoke }, true).description;
    expect(chat).toContain('as an attachment in this chat');
    expect(chat).toContain('every file meant for the user');
    expect(chat).toContain('Not for helper scripts or intermediate files.');
    expect(chat).toContain(
      'it sends PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), text, CSV, Markdown, PNG or JPEG files only.',
    );
    expect(chat).toContain(
      'do not send a file you downloaded from the internet unless the user asked for that exact file',
    );
    const room = buildSendFileTool({ invoke }, false).description;
    expect(room).not.toContain('attachment');
    expect(room).toContain('as a link posted in this room');
    expect(room).toContain('never paste a download link');
  });

  it('warns of the gateway file check only where a gateway delivers the file', async () => {
    const invoke = async (): Promise<string> => PRESIGNED;
    const chat = buildSendFileTool({ invoke }, true).description;
    expect(chat).toContain(FILE_SAFETY_NOTE);
    expect(FILE_SAFETY_NOTE).toContain('blocks macros, embedded objects');
    expect(FILE_SAFETY_NOTE).toContain(
      'do not state that it is attached or delivered',
    );
    // A Matrix room posts a link; nothing checks the file, so nothing changes there.
    const room = buildSendFileTool({ invoke }, false);
    expect(room.description).not.toContain('scans');
    expect(room.description).not.toContain('attached or delivered');
    const posted = (await room.handler(
      { path: '/output/report.docx' },
      contextWith(recordingLogger()),
    )) as ToolMessage;
    expect(JSON.parse(posted.content as string).delivery).toBe(
      'Attached to your reply: it goes out when the reply does. Do not paste a link.',
    );
  });

  it('is read-only, so a resumed run may run it again', () => {
    expect(
      buildSendFileTool({ invoke: async () => PRESIGNED }, true).effect,
    ).toBe('read');
  });

  it('refuses a caption over 1,024 characters', () => {
    const { schema } = buildSendFileTool(
      { invoke: async () => PRESIGNED },
      true,
    );
    expect(
      schema.safeParse({ path: '/a.pdf', caption: 'x'.repeat(1025) }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ path: '/a.pdf', caption: 'x'.repeat(1024) }).success,
    ).toBe(true);
  });
});
