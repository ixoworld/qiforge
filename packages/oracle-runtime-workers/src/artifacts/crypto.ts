/**
 * Share-copy encryption. An artefact's share copy is AES-256-GCM ciphertext;
 * the key travels only in the link's fragment (`#k=`), which browsers never
 * send to a server, so the bucket, the logs and link-preview crawlers see
 * nothing readable. Object layout: 12-byte IV, then the ciphertext.
 */

export interface ArtifactEnvelope {
  v: 1;
  title: string;
  mime: 'text/markdown';
  content: string;
  createdAt: string;
}

const IV_BYTES = 12;

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** A fresh 256-bit share key, base64url. */
export function newShareKey(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function importKey(
  key: string,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64url(key), 'AES-GCM', false, [
    usage,
  ]);
}

export async function sealArtifact(
  key: string,
  envelope: ArtifactEnvelope,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await importKey(key, 'encrypt'),
      new TextEncoder().encode(JSON.stringify(envelope)),
    ),
  );
  const sealed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  sealed.set(iv, 0);
  sealed.set(ciphertext, IV_BYTES);
  return sealed;
}

/** The viewer's decryption, for tests and the owner API. */
export async function openArtifact(
  key: string,
  sealed: Uint8Array,
): Promise<ArtifactEnvelope> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.slice(0, IV_BYTES) },
    await importKey(key, 'decrypt'),
    sealed.slice(IV_BYTES),
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('content' in parsed) ||
    typeof parsed.content !== 'string' ||
    !('title' in parsed) ||
    typeof parsed.title !== 'string' ||
    !('createdAt' in parsed) ||
    typeof parsed.createdAt !== 'string'
  )
    throw new Error('artifacts: the share copy is not a valid envelope');
  return {
    v: 1,
    title: parsed.title,
    mime: 'text/markdown',
    content: parsed.content,
    createdAt: parsed.createdAt,
  };
}
