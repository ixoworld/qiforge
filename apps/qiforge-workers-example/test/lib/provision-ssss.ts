/**
 * Provision Matrix Secret Storage (SSSS) + a megolm key-backup secret on an
 * oracle account — the harness-side equivalent of the production onboarding
 * step (portal / oracles-cli) that the Node runtime's
 * `extractBackupKeyFromSSS` and the Workers gateway's `adoptAccountCrypto`
 * both expect to have happened.
 *
 * Creates, if absent:
 *  - `m.secret_storage.key.<id>` — passphrase-derived (PBKDF2-SHA512) key
 *    description with the spec iv/mac key-check, unlockable from
 *    MATRIX_RECOVERY_PHRASE by both runtimes.
 *  - `m.secret_storage.default_key` → that key.
 *  - `m.megolm_backup.v1` — a fresh random 32-byte backup decryption key,
 *    AES-CTR/HMAC encrypted under the SSSS key. The Node runtime extracts it
 *    and its bot-sdk then creates the server-side backup version from it and
 *    uploads all room keys; a later new device restores them via the phrase.
 *
 * Wire format mirrors `packages/matrix/src/utils/ssss.ts` exactly.
 *
 * Env: MATRIX_BASE_URL, MATRIX_ORACLE_ADMIN_USER_ID,
 * MATRIX_ORACLE_ADMIN_ACCESS_TOKEN, MATRIX_RECOVERY_PHRASE.
 */
import * as crypto from 'node:crypto';

const PBKDF2_ITERATIONS = 500000;

interface EncryptedPart {
  iv: string;
  ciphertext: string;
  mac: string;
}

function b64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

async function deriveMasterKey(
  passphrase: string,
  salt: string,
  iterations: number,
  bits = 256,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(salt),
      iterations,
      hash: 'SHA-512',
    },
    key,
    bits,
  );
  return new Uint8Array(keyBits);
}

async function deriveKeys(masterKey: Uint8Array, secretName: string) {
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    masterKey,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      salt: new Uint8Array(8),
      info: new TextEncoder().encode(secretName),
      hash: 'SHA-256',
    },
    hkdfKey,
    512,
  );
  const aesKey = await crypto.subtle.importKey(
    'raw',
    keyBits.slice(0, 32),
    { name: 'AES-CTR' },
    false,
    ['encrypt'],
  );
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    keyBits.slice(32),
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign'],
  );
  return [aesKey, hmacKey] as const;
}

async function encryptSecret(
  plaintext: string,
  masterKey: Uint8Array,
  secretName: string,
): Promise<EncryptedPart> {
  const [aesKey, hmacKey] = await deriveKeys(masterKey, secretName);
  const iv = new Uint8Array(crypto.randomBytes(16));
  iv[8]! &= 0x7f;
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: iv, length: 64 },
      aesKey,
      new TextEncoder().encode(plaintext),
    ),
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign({ name: 'HMAC' }, hmacKey, ciphertext),
  );
  return { iv: b64(iv), ciphertext: b64(ciphertext), mac: b64(mac) };
}

async function putAccountData(
  baseUrl: string,
  token: string,
  userId: string,
  type: string,
  content: unknown,
): Promise<void> {
  const url = `${baseUrl}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(content),
  });
  if (!res.ok) {
    throw new Error(`PUT ${type} failed: ${res.status} ${await res.text()}`);
  }
}

async function getAccountData(
  baseUrl: string,
  token: string,
  userId: string,
  type: string,
): Promise<unknown | null> {
  const url = `${baseUrl}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET ${type} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function provisionSSSS(opts: {
  baseUrl: string;
  accessToken: string;
  userId: string;
  recoveryPhrase: string;
}): Promise<{ keyId: string; created: boolean }> {
  const { baseUrl, accessToken, userId, recoveryPhrase } = opts;

  const existing = (await getAccountData(
    baseUrl,
    accessToken,
    userId,
    'm.secret_storage.default_key',
  )) as { key?: string } | null;
  if (existing?.key) {
    const backupSecret = await getAccountData(
      baseUrl,
      accessToken,
      userId,
      'm.megolm_backup.v1',
    );
    if (backupSecret) {
      return { keyId: existing.key, created: false };
    }
    throw new Error(
      `SSSS default key ${existing.key} exists but m.megolm_backup.v1 is missing — refusing to guess; provision the backup secret against the existing key manually`,
    );
  }

  const keyId = crypto.randomBytes(8).toString('hex');
  const salt = crypto.randomBytes(24).toString('base64');
  const masterKey = await deriveMasterKey(
    recoveryPhrase,
    salt,
    PBKDF2_ITERATIONS,
  );

  // Spec key-check: encrypt 32 zero bytes with secretName '' and publish iv/mac.
  const check = await encryptSecret('\0'.repeat(32), masterKey, '');
  await putAccountData(
    baseUrl,
    accessToken,
    userId,
    `m.secret_storage.key.${keyId}`,
    {
      algorithm: 'm.secret_storage.v1.aes-hmac-sha2',
      passphrase: {
        algorithm: 'm.pbkdf2',
        iterations: PBKDF2_ITERATIONS,
        salt,
        bits: 256,
      },
      iv: check.iv,
      mac: check.mac,
    },
  );
  await putAccountData(
    baseUrl,
    accessToken,
    userId,
    'm.secret_storage.default_key',
    {
      key: keyId,
    },
  );

  const backupKeyB64 = crypto.randomBytes(32).toString('base64');
  const encrypted = await encryptSecret(
    backupKeyB64,
    masterKey,
    'm.megolm_backup.v1',
  );
  await putAccountData(baseUrl, accessToken, userId, 'm.megolm_backup.v1', {
    encrypted: { [keyId]: encrypted },
  });

  return { keyId, created: true };
}

const invokedDirectly = process.argv[1]?.endsWith('provision-ssss.ts') ?? false;
if (invokedDirectly) {
  const baseUrl = process.env.MATRIX_BASE_URL;
  const accessToken = process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN;
  const userId = process.env.MATRIX_ORACLE_ADMIN_USER_ID;
  const recoveryPhrase = process.env.MATRIX_RECOVERY_PHRASE;
  if (!baseUrl || !accessToken || !userId || !recoveryPhrase) {
    console.error(
      'Required env: MATRIX_BASE_URL, MATRIX_ORACLE_ADMIN_ACCESS_TOKEN, MATRIX_ORACLE_ADMIN_USER_ID, MATRIX_RECOVERY_PHRASE',
    );
    process.exit(1);
  }
  provisionSSSS({ baseUrl, accessToken, userId, recoveryPhrase })
    .then(({ keyId, created }) => {
      console.log(
        created
          ? `SSSS provisioned: default key ${keyId} + m.megolm_backup.v1 secret`
          : `SSSS already provisioned (default key ${keyId}); nothing changed`,
      );
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
