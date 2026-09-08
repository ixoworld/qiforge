/**
 * `view_attachment` + the attachments plugin: argument validation, the text
 * and native result shapes, and the request-time gating on the host surface.
 */
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_VIEW_SOURCE } from '../../attachments';
import type { AttachmentViewSurface } from '../../attachments/view';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import { AttachmentsPlugin } from './attachments.plugin';
import {
  createViewAttachmentTool,
  viewAttachmentSchema,
} from './view-attachment-tool';

const META = {
  filename: 'red.png',
  mimetype: 'image/png',
  size: 12,
  mxcUri: 'mxc://hs/red',
  category: 'image',
};

function surface(
  view: AttachmentViewSurface['view'],
  offloaded = true,
): AttachmentViewSurface {
  return { offloaded, view };
}

function ctxWith(
  attachments: AttachmentViewSurface | undefined,
  extra: { toolCallId?: string; client?: 'portal' | 'matrix' } = {},
): RuntimeContext {
  const base = makeRuntimeContext();
  return makeRuntimeContext({
    ...(attachments ? { attachments } : {}),
    ...(extra.toolCallId ? { toolCallId: extra.toolCallId } : {}),
    session: { ...base.session, client: extra.client ?? 'portal' },
  });
}

describe('view_attachment', () => {
  it('validates its argument', async () => {
    expect(viewAttachmentSchema.safeParse({ ref: '' }).success).toBe(false);
    expect(viewAttachmentSchema.safeParse({}).success).toBe(false);
    const tool = createViewAttachmentTool();
    await expect(
      tool.handler(
        { ref: '' },
        ctxWith(
          surface(async () => {
            throw new Error('unreachable');
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('fails clearly when the host offers no attachment access', async () => {
    await expect(
      createViewAttachmentTool().handler(
        { ref: 'mxc://hs/red' },
        ctxWith(undefined),
      ),
    ).rejects.toThrow(/not available on this host/);
  });

  it('returns the text lane as the tool output', async () => {
    const refs: string[] = [];
    const tool = createViewAttachmentTool();
    const out = await tool.handler(
      { ref: 'mxc://hs/red' },
      ctxWith(
        surface(async (ref) => {
          refs.push(ref);
          return {
            meta: META,
            view: {
              kind: 'text',
              text: 'Description of red.png: a red square',
            },
          };
        }),
        { toolCallId: 'call_1' },
      ),
    );
    expect(out).toBe('Description of red.png: a red square');
    expect(refs).toEqual(['mxc://hs/red']);
  });

  it('re-attaches the native lane through a Command (tool message + tagged human message)', async () => {
    const tool = createViewAttachmentTool();
    const out = await tool.handler(
      { ref: 'mxc://hs/red' },
      ctxWith(
        surface(async () => ({
          meta: META,
          view: {
            kind: 'native',
            native: {
              kind: 'image',
              mimeType: 'image/png',
              base64: 'AAAA',
              filename: 'red.png',
            },
          },
        })),
        { toolCallId: 'call_2', client: 'matrix' },
      ),
    );
    expect(out).toBeInstanceOf(Command);
    const update = (out as Command).update;
    if (!update || Array.isArray(update))
      throw new Error('expected an object update');
    const messages = update.messages as unknown[];
    expect(messages).toHaveLength(2);
    const [toolMessage, human] = messages;
    expect(toolMessage).toBeInstanceOf(ToolMessage);
    expect((toolMessage as ToolMessage).tool_call_id).toBe('call_2');
    expect(human).toBeInstanceOf(HumanMessage);
    const re = human as HumanMessage;
    expect(re.additional_kwargs.lc_source).toBe(ATTACHMENT_VIEW_SOURCE);
    expect(re.additional_kwargs.msgFromMatrixRoom).toBe(true);
    expect(re.additional_kwargs.attachments).toEqual([META]);
    expect(re.content).toEqual([
      { type: 'text', text: expect.stringContaining('Re-attached "red.png"') },
      {
        type: 'image',
        source_type: 'base64',
        mime_type: 'image/png',
        data: 'AAAA',
      },
    ]);
  });

  it('cannot re-attach natively outside a tool call', async () => {
    await expect(
      createViewAttachmentTool().handler(
        { ref: 'mxc://hs/red' },
        ctxWith(
          surface(async () => ({
            meta: META,
            view: {
              kind: 'native',
              native: {
                kind: 'image',
                mimeType: 'image/png',
                base64: 'AAAA',
                filename: 'red.png',
              },
            },
          })),
        ),
      ),
    ).rejects.toThrow(/outside a tool call/);
  });

  it('propagates an unknown reference from the host', async () => {
    await expect(
      createViewAttachmentTool().handler(
        { ref: '$nope' },
        ctxWith(
          surface(async (ref) => {
            throw new Error(
              `no attachment with ref "${ref}" in this conversation`,
            );
          }),
          { toolCallId: 'call_3' },
        ),
      ),
    ).rejects.toThrow(/no attachment with ref "\$nope"/);
  });
});

describe('AttachmentsPlugin', () => {
  it('offers view_attachment only once the session has an offloaded payload', () => {
    const plugin = new AttachmentsPlugin();
    expect(plugin.getRequestTools(ctxWith(undefined))).toEqual([]);
    expect(
      plugin.getRequestTools(
        ctxWith(
          surface(async () => {
            throw new Error('unused');
          }, false),
        ),
      ),
    ).toEqual([]);
    const tools = plugin.getRequestTools(
      ctxWith(
        surface(async () => {
          throw new Error('unused');
        }, true),
      ),
    );
    expect(tools.map((t) => t.name)).toEqual(['view_attachment']);
  });
});
