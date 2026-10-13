import { describe, expect, it } from 'vitest';
import {
  base64url,
  fromBase64url,
  newShareKey,
  openArtifact,
  sealArtifact,
  type ArtifactEnvelope,
} from './crypto';

const ENVELOPE: ArtifactEnvelope = {
  v: 1,
  title: 'Plan',
  mime: 'text/markdown',
  content: '# Plan\n\nWeek one — ünïcode ✓',
  createdAt: '2026-10-01T09:00:00.000Z',
};

describe('artefact share-copy encryption', () => {
  it('opens what it sealed, with a fresh IV per seal', async () => {
    const key = newShareKey();
    const a = await sealArtifact(key, ENVELOPE);
    const b = await sealArtifact(key, ENVELOPE);
    expect(await openArtifact(key, a)).toEqual(ENVELOPE);
    expect(a.slice(0, 12)).not.toEqual(b.slice(0, 12));
  });

  it('refuses a copy with any single bit changed: IV, ciphertext or tag', async () => {
    const key = newShareKey();
    const sealed = await sealArtifact(key, ENVELOPE);
    for (const at of [
      0,
      11,
      12,
      Math.floor(sealed.length / 2),
      sealed.length - 1,
    ]) {
      const tampered = sealed.slice();
      tampered[at] = tampered[at]! ^ 0x01;
      await expect(openArtifact(key, tampered), `byte ${at}`).rejects.toThrow();
    }
  });

  it('refuses the wrong key, a truncated copy and a sealed non-envelope', async () => {
    const key = newShareKey();
    const sealed = await sealArtifact(key, ENVELOPE);
    await expect(openArtifact(newShareKey(), sealed)).rejects.toThrow();
    await expect(openArtifact(key, sealed.slice(0, 20))).rejects.toThrow();
    await expect(openArtifact(key, sealed.slice(0, -1))).rejects.toThrow();
    // Authentic ciphertext of JSON that is not an envelope.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      fromBase64url(key),
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const body = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        new TextEncoder().encode(JSON.stringify({ title: 'x', content: 1 })),
      ),
    );
    const foreign = new Uint8Array(12 + body.length);
    foreign.set(iv, 0);
    foreign.set(body, 12);
    await expect(openArtifact(key, foreign)).rejects.toThrow(
      /not a valid envelope/,
    );
  });

  it('round-trips base64url without padding and makes 256-bit keys', () => {
    for (let n = 0; n < 40; n += 1) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      const text = base64url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(fromBase64url(text)).toEqual(bytes);
    }
    expect(fromBase64url(newShareKey())).toHaveLength(32);
  });
});
