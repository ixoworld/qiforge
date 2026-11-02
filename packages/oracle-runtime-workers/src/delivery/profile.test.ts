import { describe, expect, it } from 'vitest';
import { deliveryConfigWithEnv, resolveDeliveryProfile } from './profile';
import { renderSurfaceSection } from './prompt';

const whatsapp = {
  client: 'channel' as const,
  channel: {
    provider: 'whatsapp',
    bindingId: 'chb_x',
    remoteMessageRef: 'hmac:x',
  },
};

describe('resolveDeliveryProfile', () => {
  it('streams Portal turns', () => {
    expect(resolveDeliveryProfile({ client: 'portal' })).toEqual({
      kind: 'stream',
    });
  });

  it('uses the provider profile for channel turns', () => {
    const profile = resolveDeliveryProfile(whatsapp);
    expect(profile).toMatchObject({
      kind: 'chat',
      surface: 'whatsapp',
      label: 'WhatsApp',
      limits: { maxBubbles: 3, bubbleMax: 1500, tables: false },
    });
  });

  it('keeps ordinary answers in chat by default: only document-length steps spill', () => {
    const limitsOf = (provider: string) => {
      const profile = resolveDeliveryProfile({
        ...whatsapp,
        channel: { ...whatsapp.channel, provider },
      });
      if (profile.kind !== 'chat') throw new Error('expected a chat profile');
      return profile.limits;
    };
    const shared = {
      minBubble: 60,
      maxBubbles: 3,
      maxPartsPerRun: 8,
      maxListItems: 15,
      previewItems: 3,
      maxCodeLines: 40,
      tables: false,
    };
    expect(limitsOf('whatsapp')).toEqual({
      ...shared,
      bubbleTarget: 600,
      bubbleMax: 1500,
      spillChars: 4500,
    });
    expect(limitsOf('sms')).toEqual(limitsOf('whatsapp'));
    expect(limitsOf('telegram')).toEqual({
      ...shared,
      bubbleTarget: 800,
      bubbleMax: 2000,
      spillChars: 4500,
    });
    expect(limitsOf('slack')).toEqual({
      ...shared,
      bubbleTarget: 1200,
      bubbleMax: 3000,
      spillChars: 6000,
    });
    expect(limitsOf('matrix')).toEqual({
      ...shared,
      bubbleTarget: 1200,
      bubbleMax: 4000,
      spillChars: 8000,
    });
  });

  it('falls back to the generic profile for a provider without its own', () => {
    for (const provider of ['telegram-bot', 'constructor', 'sms']) {
      const profile = resolveDeliveryProfile({
        ...whatsapp,
        channel: { ...whatsapp.channel, provider },
      });
      expect(profile).toMatchObject({ kind: 'chat', surface: 'generic' });
    }
  });

  it('keeps Matrix rooms on one message per reply unless the chat style is turned on', () => {
    expect(resolveDeliveryProfile({ client: 'matrix' })).toEqual({
      kind: 'stream',
    });
    expect(
      resolveDeliveryProfile({ client: 'matrix' }, { matrixChat: false }),
    ).toEqual({ kind: 'stream' });
    expect(
      resolveDeliveryProfile({ client: 'matrix' }, { matrixChat: true }),
    ).toMatchObject({
      kind: 'chat',
      surface: 'matrix',
      limits: { maxBubbles: 3, maxPartsPerRun: 8 },
    });
    expect(
      resolveDeliveryProfile(
        { client: 'matrix', roomKind: 'group' },
        { matrixChat: true },
      ),
    ).toMatchObject({
      limits: { maxBubbles: 2, maxPartsPerRun: 3, spillChars: 2400 },
    });
  });

  it('lets MATRIX_CHAT_DELIVERY decide the Matrix chat style when it is set', () => {
    expect(deliveryConfigWithEnv(undefined, undefined).matrixChat).toBe(false);
    expect(deliveryConfigWithEnv({ matrixChat: true }, undefined)).toEqual({
      matrixChat: true,
    });
    expect(deliveryConfigWithEnv(undefined, 'true').matrixChat).toBe(true);
    expect(
      deliveryConfigWithEnv(
        { matrixChat: true, limits: { matrix: { maxBubbles: 2 } } },
        'false',
      ),
    ).toEqual({ matrixChat: false, limits: { matrix: { maxBubbles: 2 } } });
  });

  it('streams scheduled task runs on every surface, so a stored result keeps its whole text', () => {
    const config = { matrixChat: true };
    expect(
      resolveDeliveryProfile(
        { client: 'matrix', taskRunId: 'run-1', sessionId: 'task:t1' },
        config,
      ),
    ).toEqual({ kind: 'stream' });
    // A recovered task run is recognised by its session as well.
    expect(
      resolveDeliveryProfile(
        { client: 'matrix', sessionId: 'task:t1' },
        config,
      ),
    ).toEqual({ kind: 'stream' });
    expect(resolveDeliveryProfile({ ...whatsapp, taskRunId: 'run-2' })).toEqual(
      { kind: 'stream' },
    );
    expect(
      resolveDeliveryProfile({ client: 'matrix', sessionId: '$root' }, config),
    ).toMatchObject({ kind: 'chat' });
  });

  it('lets an oracle override limits per surface', () => {
    expect(
      resolveDeliveryProfile(whatsapp, {
        limits: { whatsapp: { maxBubbles: 2 } },
      }),
    ).toMatchObject({ limits: { maxBubbles: 2, bubbleMax: 1500 } });
  });

  it('keeps the default for an override that is not a whole number of at least 1', () => {
    expect(
      resolveDeliveryProfile(whatsapp, {
        limits: {
          whatsapp: {
            bubbleMax: 0,
            maxPartsPerRun: -2,
            maxBubbles: 2.5,
            spillChars: Number.NaN,
            maxCodeLines: 20,
          },
        },
      }),
    ).toMatchObject({
      limits: {
        bubbleMax: 1500,
        maxPartsPerRun: 8,
        maxBubbles: 3,
        spillChars: 4500,
        maxCodeLines: 20,
      },
    });
  });

  it('keeps the soft target and the merge threshold within the hard size', () => {
    expect(
      resolveDeliveryProfile(whatsapp, {
        limits: { whatsapp: { bubbleMax: 400 } },
      }),
    ).toMatchObject({
      limits: { bubbleMax: 400, bubbleTarget: 400, minBubble: 60 },
    });
    expect(
      resolveDeliveryProfile(whatsapp, {
        limits: { whatsapp: { bubbleMax: 50 } },
      }),
    ).toMatchObject({
      limits: { bubbleMax: 50, bubbleTarget: 50, minBubble: 50 },
    });
  });
});

describe('renderSurfaceSection', () => {
  it('renders nothing on the Portal', () => {
    expect(renderSurfaceSection({ kind: 'stream' }, true, true)).toBe('');
    expect(renderSurfaceSection(undefined, true, true)).toBe('');
  });

  it('names the surface and mentions create_artifact only when it is bound', () => {
    const profile = resolveDeliveryProfile(whatsapp);
    const withArtifacts = renderSurfaceSection(profile, true, false);
    expect(withArtifacts).toContain('You are replying in WhatsApp.');
    expect(withArtifacts).toContain('create_artifact');
    expect(withArtifacts).toContain('under about 600 characters');
    const without = renderSurfaceSection(profile, false, false);
    expect(without).not.toContain('create_artifact');
    expect(without).toContain(
      'Everything you write is delivered as messages; when something is genuinely long, put the essential part first.',
    );
    expect(without).not.toContain('offer the rest');
  });

  it('keeps ordinary answers in chat and reserves create_artifact for documents', () => {
    const profile = resolveDeliveryProfile(whatsapp);
    const section = renderSurfaceSection(profile, true, false);
    expect(section).toContain('no browser');
    expect(section).toContain('Prefer two or three messages.');
    expect(section).toContain('A blank line marks where a message may break');
    expect(section).not.toContain('A blank line starts a new message');
    expect(section).toContain(
      'Lists up to 15 items, code up to 40 lines and **bold** for the key fact are fine in chat.',
    );
    expect(section).toContain('never leave content out to fit');
    expect(section).toContain('Ordinary answers stay in chat');
    expect(section).toContain('not a table');
    const artifactLine = section
      .split('\n')
      .find((line) => line.includes('create_artifact'));
    expect(artifactLine).toContain('document-length');
    expect(artifactLine).toContain('conclusions, decisions and next actions');
    expect(artifactLine).not.toMatch(/comparison|table|plan|list/i);
    // A group room is asked for fewer messages.
    expect(
      renderSurfaceSection(
        resolveDeliveryProfile(
          { client: 'matrix', roomKind: 'group' },
          { matrixChat: true },
        ),
        true,
        false,
      ),
    ).toContain('Prefer one or two messages.');
  });

  it('tells the model to deliver a made file with send_file, only when it is bound', () => {
    const profile = resolveDeliveryProfile(whatsapp);
    expect(renderSurfaceSection(profile, true, false)).not.toContain(
      'send_file',
    );
    const line = renderSurfaceSection(profile, true, true)
      .split('\n')
      .find((text) => text.includes('send_file'));
    expect(line).toContain('every file meant for the user');
    expect(line).toContain('as an attachment');
    expect(line).toContain('Never paste a download link');
    // The bullet comes first, and leaves create_artifact the formatless document.
    const lines = renderSurfaceSection(profile, true, true).split('\n');
    const artifact = lines.findIndex((text) =>
      text.includes('Use `create_artifact`'),
    );
    expect(lines.findIndex((text) => text.includes('send_file'))).toBe(
      artifact - 1,
    );
    expect(lines[artifact]).toContain(
      '- Use `create_artifact` for a document with no particular file format, or when the output is genuinely document-length',
    );
    expect(lines[artifact]).toContain(
      'conclusions, decisions and next actions',
    );
    expect(renderSurfaceSection(profile, false, true)).toContain(
      'Everything you write is delivered as messages',
    );
    expect(renderSurfaceSection(profile, false, true)).toContain('send_file');
    expect(renderSurfaceSection(profile, false, true)).not.toContain(
      'create_artifact',
    );
    // Without send_file the WhatsApp-first wording stands as it was.
    expect(renderSurfaceSection(profile, true, false)).toContain(
      '- Use `create_artifact` only when the user asks for a document or file, or when',
    );
  });

  it('promises no attachment in a Matrix room, which gets a link line', () => {
    const line = renderSurfaceSection(
      resolveDeliveryProfile(
        { client: 'matrix', roomKind: 'direct' },
        { matrixChat: true },
      ),
      false,
      true,
    )
      .split('\n')
      .find((text) => text.includes('send_file'));
    expect(line).toContain('a link to the file is posted here for you');
    expect(line).not.toContain('attachment');
  });
});
