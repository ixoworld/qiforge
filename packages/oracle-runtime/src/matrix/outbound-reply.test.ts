import { describe, expect, it, vi } from 'vitest';
import {
  MATRIX_MESSAGE_OVERFLOW_CHARS,
  postAgentReplyToMatrix,
  splitOverflowReply,
  type OutboundMatrixSender,
} from './outbound-reply.js';

function managerMock(overrides: {
  sendFileMessage?: ReturnType<typeof vi.fn>;
  sendMessage?: ReturnType<typeof vi.fn>;
}): {
  manager: OutboundMatrixSender;
  sendFileMessage: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendFileMessage =
    overrides.sendFileMessage ?? vi.fn().mockResolvedValue('$file');
  const sendMessage =
    overrides.sendMessage ?? vi.fn().mockResolvedValue('$msg');
  return {
    manager: { sendFileMessage, sendMessage },
    sendFileMessage,
    sendMessage,
  };
}

describe('splitOverflowReply', () => {
  it('keeps content at or under the budget in chat', () => {
    expect(splitOverflowReply('short reply')).toEqual({ fitsInChat: true });
    expect(
      splitOverflowReply('x'.repeat(MATRIX_MESSAGE_OVERFLOW_CHARS)),
    ).toEqual({ fitsInChat: true });
  });

  it('uses the first paragraph as the lead-in for overflow', () => {
    const content = `This is the opening summary paragraph.\n\n${'y'.repeat(3000)}`;
    const split = splitOverflowReply(content);
    expect(split.fitsInChat).toBe(false);
    expect(split.leadIn).toContain('This is the opening summary paragraph.');
    expect(split.leadIn).toContain('full response attached');
  });

  it('caps a long first paragraph at a word boundary', () => {
    const longParagraph = `${'word '.repeat(200)}end`;
    const split = splitOverflowReply(`${longParagraph}\n\n${'y'.repeat(3000)}`);
    expect(split.fitsInChat).toBe(false);
    const [firstLine] = split.leadIn!.split('\n');
    expect(firstLine!.length).toBeLessThanOrEqual(310);
    expect(firstLine!.endsWith('…')).toBe(true);
  });

  it('falls back to a generic lead-in when the paragraph opens a code fence or heading', () => {
    const fenced = `\`\`\`ts\nconst x = 1;\n\`\`\`\n\n${'y'.repeat(3000)}`;
    expect(splitOverflowReply(fenced).leadIn).toContain(
      'Full response attached',
    );
    const heading = `# Big Report\n\n${'y'.repeat(3000)}`;
    expect(splitOverflowReply(heading).leadIn).toContain(
      'Full response attached',
    );
  });
});

describe('postAgentReplyToMatrix', () => {
  it('posts small replies as a plain message', async () => {
    const { manager, sendFileMessage, sendMessage } = managerMock({});
    await postAgentReplyToMatrix({
      matrixManager: manager,
      roomId: '!room',
      threadId: '$root',
      content: 'hello',
      disablePrefix: true,
    });

    expect(sendFileMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      roomId: '!room',
      threadId: '$root',
      message: 'hello',
      isOracleAdmin: true,
      disablePrefix: true,
    });
  });

  it('attaches overflow as a markdown artefact plus a lead-in', async () => {
    const { manager, sendFileMessage, sendMessage } = managerMock({});
    const content = `Summary first.\n\n${'z'.repeat(3000)}`;
    await postAgentReplyToMatrix({
      matrixManager: manager,
      roomId: '!room',
      threadId: '$root',
      content,
      disablePrefix: true,
    });

    expect(sendFileMessage).toHaveBeenCalledTimes(1);
    const fileArgs = sendFileMessage.mock.calls[0]![0] as {
      filename: string;
      mimetype: string;
      data: Buffer;
    };
    expect(fileArgs.filename).toMatch(/^response-.*\.md$/);
    expect(fileArgs.mimetype).toBe('text/markdown');
    expect(fileArgs.data.toString('utf-8')).toBe(content);

    const messageArgs = sendMessage.mock.calls[0]![0] as { message: string };
    expect(messageArgs.message).toContain('Summary first.');
  });

  it('falls back to posting the full text when the upload fails', async () => {
    const { manager, sendMessage } = managerMock({
      sendFileMessage: vi.fn().mockRejectedValue(new Error('upload failed')),
    });
    const content = 'q'.repeat(3000);
    await postAgentReplyToMatrix({
      matrixManager: manager,
      roomId: '!room',
      content,
      disablePrefix: false,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const args = sendMessage.mock.calls[0]![0] as {
      message: string;
      disablePrefix: boolean;
    };
    expect(args.message).toBe(content);
    expect(args.disablePrefix).toBe(false);
  });
});
