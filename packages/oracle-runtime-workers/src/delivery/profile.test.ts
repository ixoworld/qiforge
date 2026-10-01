import { describe, expect, it } from 'vitest';
import { deliveryConfigWithEnv, resolveDeliveryProfile } from './profile';
import { renderSurfaceSection } from './prompt';

const whatsapp = {
  client: 'channel' as const,
  channel: {
    provider: 'whatsapp' as const,
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
      limits: { maxBubbles: 4, bubbleMax: 1500, tables: false },
    });
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
      limits: { maxBubbles: 3, maxPartsPerRun: 5 },
    });
    expect(
      resolveDeliveryProfile(
        { client: 'matrix', roomKind: 'group' },
        { matrixChat: true },
      ),
    ).toMatchObject({ limits: { maxBubbles: 2, maxPartsPerRun: 3 } });
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
        maxPartsPerRun: 6,
        maxBubbles: 4,
        spillChars: 1800,
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
    expect(renderSurfaceSection({ kind: 'stream' }, true)).toBe('');
    expect(renderSurfaceSection(undefined, true)).toBe('');
  });

  it('names the surface and mentions create_artifact only when it is bound', () => {
    const profile = resolveDeliveryProfile(whatsapp);
    const withArtifacts = renderSurfaceSection(profile, true);
    expect(withArtifacts).toContain('You are replying in WhatsApp.');
    expect(withArtifacts).toContain('create_artifact');
    expect(withArtifacts).toContain('under about 600 characters');
    const without = renderSurfaceSection(profile, false);
    expect(without).not.toContain('create_artifact');
    expect(without).toContain('send the short version and offer the rest');
  });
});
