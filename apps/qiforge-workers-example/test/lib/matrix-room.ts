/**
 * The user↔oracle room on the LOCAL harness homeserver. In production the
 * rooms appservice creates these rooms; here the user creates an E2EE room,
 * the appservice bot joins and publishes the `#did-…_did-…` alias (an
 * exclusive appservice namespace on ixo homeservers) and the user pins it as
 * the canonical alias — which is how the gateway maps the room to its user.
 */
import {
  APPSERVICE_BOT,
  appserviceRequest,
  MATRIX_BASE_URL,
  MATRIX_SERVER_NAME,
  matrixRequest,
  type MatrixSession,
} from './harness';

/** `did:ixo:ixo1abc` → `did-ixo-ixo1abc`, the alias/localpart spelling. */
export function didToAliasPart(did: string): string {
  return did.replace(/:/g, '-');
}

export async function ensureUserOracleRoom(opts: {
  session: MatrixSession;
  userDid: string;
  /** The DID the alias is built from (`ORACLE_ENTITY_DID`; the oracle DID on the harness). */
  oracleDid: string;
  botUserId: string;
  roomName?: string;
}): Promise<string> {
  const aliasLocal = `${didToAliasPart(opts.userDid)}_${didToAliasPart(opts.oracleDid)}`;
  const alias = `#${aliasLocal}:${MATRIX_SERVER_NAME}`;
  const existing = await fetch(
    `${MATRIX_BASE_URL}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
  );
  if (existing.ok) {
    const body = (await existing.json()) as { room_id: string };
    // Make sure the bot is (re)invited if it left.
    await matrixRequest(
      opts.session,
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(body.room_id)}/invite`,
      { user_id: opts.botUserId },
    ).catch(() => undefined);
    return body.room_id;
  }
  const created = await matrixRequest<{ room_id: string }>(
    opts.session,
    'POST',
    '/_matrix/client/v3/createRoom',
    {
      preset: 'private_chat',
      name: opts.roomName ?? 'user ↔ QiForge Workers',
      invite: [opts.botUserId, APPSERVICE_BOT],
      initial_state: [
        {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        },
      ],
    },
  );
  await appserviceRequest(
    'POST',
    `/_matrix/client/v3/join/${encodeURIComponent(created.room_id)}`,
    {},
  );
  await appserviceRequest(
    'PUT',
    `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
    { room_id: created.room_id },
  );
  await matrixRequest(
    opts.session,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(created.room_id)}/state/m.room.canonical_alias`,
    { alias },
  );
  return created.room_id;
}

/** Wait until `userId` is a joined member of the room (the bot auto-joins its invite). */
export async function waitForMember(
  session: MatrixSession,
  roomId: string,
  userId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const members = await matrixRequest<{ joined: Record<string, unknown> }>(
      session,
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
    );
    if (userId in members.joined) return;
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `${userId} did not join ${roomId} within ${timeoutMs} ms`,
      );
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** Give `userId` power level `level` in the room (production rooms grant the oracle 50 at signup). */
export async function grantPowerLevel(
  session: MatrixSession,
  roomId: string,
  userId: string,
  level: number,
): Promise<void> {
  const pl = await matrixRequest<{ users?: Record<string, number> }>(
    session,
    'GET',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
  );
  if ((pl.users?.[userId] ?? 0) >= level) return;
  await matrixRequest(
    session,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
    { ...pl, users: { ...(pl.users ?? {}), [userId]: level } },
  );
}
