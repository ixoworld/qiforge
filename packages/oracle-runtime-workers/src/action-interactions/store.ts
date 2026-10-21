import {
  ActionInteractionError,
  canonicalJson,
  interactionValuesDigest,
  InteractionSchema,
  type Interaction,
  type InteractionResult,
  type PrepareInteraction,
  type UpdateInteraction,
  type ReserveInteraction,
  type ObserveInteraction,
  type CheckClaimDispatch,
} from '@ixo/action-interactions';
/* eslint-disable no-console -- console IS the logger on Workers (Logs/observability). */

const PREFIX = 'interaction:';
const REQUEST_PREFIX = 'interaction-request:';
/** `<id>:<requestId>` → requestId, so retention can drop a record's request tombstones. */
const REQUESTS_OF_PREFIX = 'interaction-requests-of:';
/** `<sha256(sessionId)>:<createdAt>:<id>` → id: lists one session without scanning the user. */
const SESSION_PREFIX = 'interaction-session:';
/** `<expiresAt>:<id>` → id: retention reads only what is due. */
const EXPIRY_PREFIX = 'interaction-expiry:';
/** `<operationKey>` → `true` once dispatched, `'released'` when the host reported nothing was sent. */
const DISPATCH_PREFIX = 'interaction-dispatch:';
/** `<id>` → the last few `{requestId, fingerprint}` of update/reserve/observe on that record. */
const RECENT_PREFIX = 'interaction-recent:';
/** `<owner key hash>` → when the ordinary form last passed the dispatch check for that claim step. */
const MANUAL_PREFIX = 'interaction-manual:';
/**
 * Replays of edits only need the newest requests: an older retry fails the
 * revision compare-and-swap instead, which never applies an edit twice.
 */
const RECENT_LIMIT = 16;
/** Values plus the user-edit list of one record, in UTF-8 bytes. */
const MAX_RECORD_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = 7 * DAY_MS;
/** How long an expired record stays readable before retention removes its values. */
const RETAIN_MS = 30 * DAY_MS;
/** The newest records one session list returns. */
const LIST_LIMIT = 50;
/** Records retention handles per prepare, so a prepare never pays for a backlog. */
const PRUNE_BATCH = 16;
/** Durable Object storage takes at most 128 keys per multi-key get, put or delete. */
const STORAGE_BATCH = 128;

type Storage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;

async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
/** Fixed-width so lexicographic key order is numeric order. */
const sortable = (value: number) =>
  Math.max(0, value).toString().padStart(16, '0');
async function sessionIndexKey(record: Interaction): Promise<string> {
  return `${SESSION_PREFIX}${await sha256Hex(record.sessionId)}:${sortable(record.createdAt)}:${record.id}`;
}
const expiryIndexKey = (record: Interaction) =>
  `${EXPIRY_PREFIX}${sortable(record.expiresAt)}:${record.id}`;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function assertRecordSize(
  values: Interaction['values'],
  updatedByUser: string[],
) {
  if (
    utf8Bytes(canonicalJson(values)) +
      utf8Bytes(JSON.stringify(updatedByUser)) >
    MAX_RECORD_BYTES
  )
    throw new ActionInteractionError(
      413,
      'too_large',
      'Draft values exceed 64 KiB',
    );
}
type RecentRequest = { requestId: string; fingerprint: string };
const manualMarkerKey = (ownerKey: string) =>
  `${MANUAL_PREFIX}${ownerKey.slice(ownerKey.indexOf(':') + 1)}`;
async function deleteKeys(storage: Storage, keys: string[]) {
  for (let i = 0; i < keys.length; i += STORAGE_BATCH)
    await storage.delete(keys.slice(i, i + STORAGE_BATCH));
}
type Command =
  | { kind: 'prepare'; input: PrepareInteraction }
  | { kind: 'update'; id: string; input: UpdateInteraction }
  | { kind: 'reserve'; id: string; input: ReserveInteraction }
  | { kind: 'observe'; id: string; input: ObserveInteraction };
export type InteractionCommand = Command;
export type InteractionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };
export async function interactionOutcome<T>(
  work: () => Promise<T>,
): Promise<InteractionOutcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof ActionInteractionError)
      return {
        ok: false,
        status: error.status,
        code: error.code,
        message: error.message,
      };
    throw error;
  }
}

async function ownerStorageKey(
  owner: Interaction['owner'],
  sessionId: string,
): Promise<string> {
  const binding =
    owner.kind === 'flow-claim'
      ? {
          kind: owner.kind,
          flowId: owner.flowId,
          runId: owner.runId,
          stepId: owner.stepId,
          accountDid: owner.accountDid,
          network: owner.network,
        }
      : owner;
  return `interaction-owner:${await sha256Hex(
    canonicalJson(
      owner.kind === 'flow-claim'
        ? { owner: binding }
        : { sessionId, owner: binding },
    ),
  )}`;
}

/**
 * Where an owner's existing record stands for a new card or a manual
 * submission of the same step:
 * - `blocked`: its operation reached the executor (the one-use dispatch key
 *   was consumed) or the host reported it observed. A second submission
 *   could duplicate the claim, so nothing replaces it.
 * - `live`: an unexpired draft, or a reservation the host is dispatching
 *   right now. It belongs to the card that owns it.
 * - `stale`: cancelled, expired, or a reservation that never reached the
 *   executor. Safe to supersede: its dispatch check can no longer pass.
 */
type OwnerState = 'blocked' | 'live' | 'stale';

/** Personal drafts only. Execution and verified receipts remain owned by Flow. */
export class ActionInteractionStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly context: { oracleDid: string; userDid: string },
    private readonly now: () => number = Date.now,
  ) {}

  /** A dispatch precondition, never an authorization grant or an executor. */
  async checkClaimDispatch(
    input: CheckClaimDispatch,
  ): Promise<{ allowed: true; managed: boolean }> {
    if (input.owner.accountDid !== this.context.userDid)
      throw new ActionInteractionError(
        403,
        'account_mismatch',
        'Claim account differs from authenticated user',
      );
    const ownerKey = await ownerStorageKey(input.owner, '');
    const manualKey = manualMarkerKey(ownerKey);
    return this.storage.transaction(async (tx) => {
      const id = await tx.get<string>(ownerKey);
      const record = id ? await this.recordFrom(tx, id) : undefined;
      if (!input.cardRef) {
        // The ordinary form. It only has to wait for a Companion operation
        // that may already have reached the executor; any other draft for
        // this step is superseded, so its own dispatch check can no longer
        // pass and the step is never locked by an abandoned card. The
        // marker stops a card prepared later from filing the same claim.
        if (id && !record)
          throw new ActionInteractionError(
            409,
            'review_required',
            'This claim step has an unreadable Companion draft',
          );
        if (record && (await this.ownerState(tx, record)) === 'blocked')
          throw new ActionInteractionError(
            409,
            'dispatch_consumed',
            'A Companion submission for this claim step already reached the claim service; check the claims list before submitting again',
          );
        if (record) await this.supersede(tx, record);
        await tx.put(manualKey, this.now());
        return { allowed: true, managed: false };
      }
      if (!record)
        throw new ActionInteractionError(
          409,
          'review_required',
          'No matching managed draft exists for this owner',
        );
      const manualAt = await tx.get<number>(manualKey);
      if (manualAt !== undefined && manualAt >= record.createdAt)
        throw new ActionInteractionError(
          409,
          'dispatch_consumed',
          'This claim step was submitted from the form; check the claims list before submitting again',
        );
      if (
        !record ||
        canonicalJson(record.owner) !== canonicalJson(input.owner) ||
        record.status !== 'reserved' ||
        record.expiresAt <= this.now() ||
        record.id !== input.cardRef ||
        !input.operationKey ||
        record.reservation?.operationKey !== input.operationKey ||
        !input.valuesDigest ||
        record.reservation.valuesDigest !== input.valuesDigest
      )
        throw new ActionInteractionError(
          409,
          'review_required',
          'This claim step has a managed draft; reopen and review its current operation',
        );
      const consumedKey = `${DISPATCH_PREFIX}${input.operationKey}`;
      if ((await tx.get<true | 'released'>(consumedKey)) !== undefined)
        throw new ActionInteractionError(
          409,
          'dispatch_consumed',
          'The reserved operation was already dispatched; reconcile its outcome',
        );
      await tx.put(consumedKey, true);
      return { allowed: true, managed: true };
    });
  }

  async read(id: string, sessionId: string): Promise<Interaction> {
    return this.readFrom(this.storage, id, sessionId);
  }

  /** The session's newest records, oldest first, read through its own index. */
  async list(sessionId: string): Promise<Interaction[]> {
    const index = await this.storage.list<string>({
      prefix: `${SESSION_PREFIX}${await sha256Hex(sessionId)}:`,
      reverse: true,
      limit: LIST_LIMIT,
    });
    const ids = Array.from(index.values()).reverse();
    const records = new Map<string, unknown>();
    for (let i = 0; i < ids.length; i += STORAGE_BATCH)
      for (const [key, value] of await this.storage.get<unknown>(
        ids.slice(i, i + STORAGE_BATCH).map((id) => `${PREFIX}${id}`),
      ))
        records.set(key, value);
    return ids.flatMap((id) => {
      const raw = records.get(`${PREFIX}${id}`);
      // One unreadable record is left out instead of failing the list.
      const record = InteractionSchema.safeParse(raw);
      return record.success && record.data.sessionId === sessionId
        ? [record.data]
        : [];
    });
  }

  /**
   * Retention for records past `expiresAt + RETAIN_MS`, a bounded batch per
   * call. Superseded or abandoned drafts disappear with their owner key,
   * indexes and request tombstones. A record whose operation reached the
   * executor keeps its owner key, reservation and dispatch tombstone forever
   * (they are what stops a duplicate claim), but loses its draft values.
   */
  async prune(): Promise<number> {
    const due = await this.storage.list<string>({
      prefix: EXPIRY_PREFIX,
      end: `${EXPIRY_PREFIX}${sortable(this.now() - RETAIN_MS)}`,
      limit: PRUNE_BATCH,
    });
    if (due.size === 0) return 0;
    await this.storage.transaction(async (tx) => {
      for (const [expiryKey, id] of due) await this.forget(tx, id, expiryKey);
    });
    return due.size;
  }

  /**
   * A deleted chat takes its drafts with it, by the same rules as
   * retention: a dispatched claim keeps only its tombstones. Bounded per
   * call; the caller repeats until it returns 0.
   */
  async forgetSession(sessionId: string): Promise<number> {
    const index = await this.storage.list<string>({
      prefix: `${SESSION_PREFIX}${await sha256Hex(sessionId)}:`,
      limit: PRUNE_BATCH,
    });
    if (index.size === 0) return 0;
    await this.storage.transaction(async (tx) => {
      for (const [indexKey, id] of index) {
        const record = await this.recordFrom(tx, id);
        await this.forget(tx, id, record ? expiryIndexKey(record) : undefined);
        // A kept tombstone leaves the deleted chat's listing too.
        await tx.delete(indexKey);
      }
    });
    return index.size;
  }

  /**
   * Removes a record and everything that points at it, except what stops a
   * duplicate claim: a dispatched record keeps its owner key, reservation and
   * dispatch tombstone, and only loses its values and user-edit list.
   */
  private async forget(tx: Storage, id: string, expiryKey?: string) {
    // Only prepare requests are indexed per record (edits keep their
    // replay window on the record itself), so this list stays small.
    const requests = await tx.list<string>({
      prefix: `${REQUESTS_OF_PREFIX}${id}:`,
      limit: 256,
    });
    const doomed = [
      ...(expiryKey ? [expiryKey] : []),
      `${RECENT_PREFIX}${id}`,
      ...requests.keys(),
      ...Array.from(requests.values(), (r) => `${REQUEST_PREFIX}${r}`),
    ];
    const record = await this.recordFrom(tx, id);
    if (record && (await this.ownerState(tx, record)) === 'blocked') {
      if (Object.keys(record.values).length || record.updatedByUser.length)
        await tx.put(`${PREFIX}${id}`, {
          ...record,
          values: {},
          updatedByUser: [],
          revision: record.revision + 1,
        } satisfies Interaction);
    } else if (record) {
      doomed.push(`${PREFIX}${id}`, await sessionIndexKey(record));
      const ownerKey = await ownerStorageKey(record.owner, record.sessionId);
      if ((await tx.get<string>(ownerKey)) === id) doomed.push(ownerKey);
    }
    await deleteKeys(tx, doomed);
  }

  private async recordFrom(
    storage: Pick<DurableObjectStorage, 'get'>,
    id: string,
  ): Promise<Interaction | undefined> {
    const raw = await storage.get<unknown>(`${PREFIX}${id}`);
    return raw === undefined ? undefined : InteractionSchema.parse(raw);
  }

  private async ownerState(
    storage: Pick<DurableObjectStorage, 'get'>,
    record: Interaction,
  ): Promise<OwnerState> {
    if (record.status === 'observed') return 'blocked';
    if (record.reservation && (await this.dispatched(storage, record)))
      return 'blocked';
    if (
      record.expiresAt > this.now() &&
      (record.status === 'draft' || record.status === 'reserved')
    )
      return 'live';
    return 'stale';
  }

  /** Whether the record's operation passed the dispatch check and was not released since. */
  private async dispatched(
    storage: Pick<DurableObjectStorage, 'get'>,
    record: Interaction,
  ): Promise<boolean> {
    return (
      !!record.reservation &&
      (await storage.get<true | 'released'>(
        `${DISPATCH_PREFIX}${record.reservation.operationKey}`,
      )) === true
    );
  }

  /** Ends a draft that can no longer dispatch; its card shows why. */
  private async supersede(storage: Storage, record: Interaction) {
    if (record.status === 'cancelled') return record;
    const ended: Interaction = {
      ...record,
      status: 'cancelled',
      cancelReason: 'superseded',
      revision: record.revision + 1,
    };
    await storage.put(`${PREFIX}${record.id}`, ended);
    return ended;
  }

  private async readFrom(
    storage: Pick<DurableObjectStorage, 'get'>,
    id: string,
    sessionId: string,
  ): Promise<Interaction> {
    const raw = await storage.get<unknown>(`${PREFIX}${id}`);
    const record = raw === undefined ? undefined : InteractionSchema.parse(raw);
    if (!record || record.sessionId !== sessionId)
      throw new ActionInteractionError(
        404,
        'not_found',
        'Interaction not found',
      );
    return record;
  }

  async command(command: Command): Promise<InteractionResult> {
    const result = await this.apply(command);
    if (command.kind === 'prepare' && !result.replayed)
      // Retention rides on new drafts: reads stay read-only and a user who
      // never prepares again has nothing new to retain.
      await this.prune().catch((error: unknown) =>
        console.warn(
          `[action-interactions] retention skipped: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    return result;
  }

  private async apply(command: Command): Promise<InteractionResult> {
    const requestId = command.input.requestId;
    const requestKey = `${REQUEST_PREFIX}${requestId}`;
    const fingerprint = await sha256Hex(
      canonicalJson(JSON.parse(JSON.stringify(command))),
    );
    // A prepare is remembered globally (it has no record id yet); an edit
    // only in its record's short replay window.
    const recentKey = (id: string) => `${RECENT_PREFIX}${id}`;
    const remember = async (tx: Storage, id: string) => {
      if (command.kind === 'prepare') {
        await tx.put({
          [requestKey]: { fingerprint, id },
          [`${REQUESTS_OF_PREFIX}${id}:${requestId}`]: requestId,
        });
        return;
      }
      const recent = (await tx.get<RecentRequest[]>(recentKey(id))) ?? [];
      await tx.put(
        recentKey(id),
        [...recent, { requestId, fingerprint }].slice(-RECENT_LIMIT),
      );
    };
    return this.storage.transaction(async (tx) => {
      const previous =
        command.kind === 'prepare'
          ? await tx.get<{ fingerprint: string; id: string }>(requestKey)
          : (await tx.get<RecentRequest[]>(recentKey(command.id)))
              ?.filter((r) => r.requestId === requestId)
              .map((r) => ({ fingerprint: r.fingerprint, id: command.id }))[0];
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ActionInteractionError(
            409,
            'request_conflict',
            'Request ID already used with different input',
          );
        return {
          interaction: await this.readFrom(
            tx,
            previous.id,
            command.input.sessionId,
          ),
          replayed: true,
        };
      }
      let record: Interaction;
      if (command.kind === 'prepare') {
        const input = command.input;
        if (
          input.owner.kind === 'flow-claim' &&
          input.owner.accountDid !== this.context.userDid
        )
          throw new ActionInteractionError(
            403,
            'account_mismatch',
            'Claim account differs from authenticated user',
          );
        assertRecordSize(input.values, []);
        const ownerKey = await ownerStorageKey(input.owner, input.sessionId);
        if (
          input.owner.kind === 'flow-claim' &&
          (await tx.get<number>(manualMarkerKey(ownerKey))) !== undefined
        )
          // The ordinary form already passed its dispatch check for this
          // step; a card could file the same claim a second time.
          throw new ActionInteractionError(
            409,
            'dispatch_consumed',
            'This claim step was submitted from the form; check the claims list before preparing another',
          );
        const existingId = await tx.get<string>(ownerKey);
        const existing = existingId
          ? await this.recordFrom(tx, existingId)
          : undefined;
        if (existing) {
          const sameOwner =
            canonicalJson(existing.owner) === canonicalJson(input.owner);
          const sameSession = existing.sessionId === input.sessionId;
          const state = await this.ownerState(tx, existing);
          const inFlight = state === 'live' && existing.status === 'reserved';
          if (
            state === 'blocked' ||
            inFlight ||
            (state === 'live' && !sameSession)
          ) {
            if (sameOwner && sameSession) {
              await remember(tx, existing.id);
              return { interaction: existing, replayed: true };
            }
            if (state === 'blocked')
              throw new ActionInteractionError(
                409,
                'dispatch_consumed',
                'This claim step already has a Companion submission; check the claims list before preparing another',
              );
            if (!sameSession)
              throw new ActionInteractionError(
                409,
                'target_in_use',
                'This claim step has an open card in another chat',
              );
            throw new ActionInteractionError(
              409,
              'target_changed',
              'The form changed while its card was being submitted; reopen it through the Flow owner',
            );
          }
          if (state === 'live' && sameOwner) {
            await remember(tx, existing.id);
            return { interaction: existing, replayed: true };
          }
          // A stale draft, or this chat's own draft for a form whose
          // collection or schema has since changed: it can no longer
          // dispatch, so a fresh draft takes its place.
          await this.supersede(tx, existing);
        }
        record = InteractionSchema.parse({
          version: 1,
          id: crypto.randomUUID(),
          revision: 1,
          sessionId: input.sessionId,
          oracleDid: this.context.oracleDid,
          owner: input.owner,
          values: input.values,
          updatedByUser: [],
          status: 'draft',
          createdAt: this.now(),
          expiresAt: this.now() + TTL_MS,
        });
        await tx.put({
          [ownerKey]: record.id,
          [await sessionIndexKey(record)]: record.id,
          [expiryIndexKey(record)]: record.id,
        });
      } else {
        record = await this.readFrom(tx, command.id, command.input.sessionId);
        // A host may report the outcome of a reservation made just before
        // expiry; every other mutation of an expired draft is refused.
        if (command.kind !== 'observe' && record.expiresAt <= this.now())
          throw new ActionInteractionError(
            410,
            'expired',
            'Interaction has expired',
          );
        if (record.revision !== command.input.expectedRevision)
          throw new ActionInteractionError(
            409,
            'stale_revision',
            'Interaction revision changed',
          );
        switch (command.kind) {
          case 'update': {
            const cancel = command.input.kind === 'cancel';
            // A reservation whose dispatch never happened (a lost reserve
            // acknowledgement, a closed tab) can still be cancelled; once
            // dispatched only its outcome may be recorded.
            const editable =
              record.status === 'draft' ||
              (cancel &&
                record.status === 'reserved' &&
                !(await this.dispatched(tx, record)));
            if (!editable)
              throw new ActionInteractionError(
                409,
                'not_editable',
                'Reserved or terminal interactions cannot be edited',
              );
            if (command.input.kind === 'cancel')
              record = { ...record, status: 'cancelled', cancelReason: 'user' };
            else {
              const input = command.input;
              const patch = Object.fromEntries(
                Object.entries(input.patch).filter(
                  ([key]) =>
                    input.source === 'user' ||
                    !record.updatedByUser.includes(key),
                ),
              );
              const removed = (input.remove ?? []).filter(
                (name) =>
                  input.source === 'user' ||
                  !record.updatedByUser.includes(name),
              );
              const merged = { ...record.values, ...patch };
              for (const name of removed) delete merged[name];
              const updatedByUser =
                input.source === 'user'
                  ? Array.from(
                      new Set([
                        ...record.updatedByUser,
                        ...Object.keys(patch),
                        ...removed,
                      ]),
                    )
                  : record.updatedByUser;
              assertRecordSize(merged, updatedByUser);
              record = { ...record, values: merged, updatedByUser };
            }
            break;
          }
          case 'reserve': {
            if (record.owner.kind !== 'flow-claim' || record.status !== 'draft')
              throw new ActionInteractionError(
                409,
                'not_dispatchable',
                'Only an unreserved claim draft can be reserved',
              );
            if (
              (await interactionValuesDigest(record.values)) !==
              command.input.valuesDigest
            )
              throw new ActionInteractionError(
                409,
                'values_changed',
                'Reviewed values do not match draft',
              );
            record = {
              ...record,
              status: 'reserved',
              reservation: {
                operationKey: crypto.randomUUID(),
                valuesDigest: command.input.valuesDigest,
              },
            };
            break;
          }
          case 'observe': {
            const outcome = command.input.outcome;
            if (
              !record.reservation ||
              record.reservation.operationKey !== command.input.operationKey ||
              !(outcome === 'not-submitted'
                ? record.status === 'reserved'
                : record.status === 'reserved' ||
                  record.status === 'outcome-unknown')
            )
              throw new ActionInteractionError(
                409,
                'reservation_mismatch',
                'No matching pending reservation',
              );
            if (command.input.outcome === 'not-submitted') {
              // The executor refused before sending anything: the card ends
              // and the step is free for the form or a new card.
              await tx.put(
                `${DISPATCH_PREFIX}${record.reservation.operationKey}`,
                'released',
              );
              record = {
                ...record,
                status: 'cancelled',
                cancelReason: 'not-submitted',
              };
            } else
              record =
                command.input.outcome === 'unknown'
                  ? { ...record, status: 'outcome-unknown' }
                  : {
                      ...record,
                      status: 'observed',
                      ownerExecutionRef: command.input.ownerExecutionRef,
                    };
            break;
          }
        }
        record = { ...record, revision: record.revision + 1 };
      }
      const result: InteractionResult = {
        interaction: record,
        replayed: false,
      };
      await tx.put(`${PREFIX}${record.id}`, record);
      await remember(tx, record.id);
      return result;
    });
  }
}
