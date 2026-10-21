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

const PREFIX = 'interaction:';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      canonicalJson(
        owner.kind === 'flow-claim'
          ? { owner: binding }
          : { sessionId, owner: binding },
      ),
    ),
  );
  return `interaction-owner:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

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
    return this.storage.transaction(async (tx) => {
      const id = await tx.get<string>(ownerKey);
      if (!id) {
        if (input.cardRef || input.operationKey)
          throw new ActionInteractionError(
            409,
            'review_required',
            'No matching managed draft exists for this owner',
          );
        return { allowed: true, managed: false };
      }
      const raw = await tx.get<unknown>(`${PREFIX}${id}`);
      const record =
        raw === undefined ? undefined : InteractionSchema.parse(raw);
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
      const consumedKey = `interaction-dispatch:${input.operationKey}`;
      if (await tx.get<boolean>(consumedKey))
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

  async list(sessionId: string): Promise<Interaction[]> {
    const records = await this.storage.list<Interaction>({
      prefix: PREFIX,
      limit: 1000,
    });
    return Array.from(records.values())
      .map((value) => InteractionSchema.parse(value))
      .filter((record) => record.sessionId === sessionId);
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
    const requestKey = `interaction-request:${command.input.requestId}`;
    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        canonicalJson(JSON.parse(JSON.stringify(command))),
      ),
    );
    const fingerprint = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    return this.storage.transaction(async (tx) => {
      const previous = await tx.get<{ fingerprint: string; id: string }>(
        requestKey,
      );
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
        const ownerKey = await ownerStorageKey(input.owner, input.sessionId);
        const existingId = await tx.get<string>(ownerKey);
        if (existingId) {
          const existing = await this.readFrom(tx, existingId, input.sessionId);
          if (canonicalJson(existing.owner) !== canonicalJson(input.owner))
            throw new ActionInteractionError(
              409,
              'target_changed',
              'The owner contract changed; reopen through the Flow owner',
            );
          await tx.put(requestKey, { fingerprint, id: existing.id });
          return { interaction: existing, replayed: true };
        }
        if (
          input.owner.kind === 'flow-claim' &&
          input.owner.accountDid !== this.context.userDid
        )
          throw new ActionInteractionError(
            403,
            'account_mismatch',
            'Claim account differs from authenticated user',
          );
        if (canonicalJson(input.values).length > 64 * 1024)
          throw new ActionInteractionError(
            413,
            'too_large',
            'Draft values exceed 64 KiB',
          );
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
        await tx.put(ownerKey, record.id);
      } else {
        record = await this.readFrom(tx, command.id, command.input.sessionId);
        if (record.expiresAt <= this.now())
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
            if (record.status !== 'draft')
              throw new ActionInteractionError(
                409,
                'not_editable',
                'Reserved or terminal interactions cannot be edited',
              );
            if (command.input.kind === 'cancel')
              record = { ...record, status: 'cancelled' };
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
              if (canonicalJson(merged).length > 64 * 1024)
                throw new ActionInteractionError(
                  413,
                  'too_large',
                  'Draft values exceed 64 KiB',
                );
              record = {
                ...record,
                values: merged,
                updatedByUser:
                  input.source === 'user'
                    ? Array.from(
                        new Set([
                          ...record.updatedByUser,
                          ...Object.keys(patch),
                          ...removed,
                        ]),
                      )
                    : record.updatedByUser,
              };
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
            if (
              !record.reservation ||
              record.reservation.operationKey !== command.input.operationKey ||
              !['reserved', 'outcome-unknown'].includes(record.status)
            )
              throw new ActionInteractionError(
                409,
                'reservation_mismatch',
                'No matching pending reservation',
              );
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
      await tx.put(requestKey, { fingerprint, id: record.id });
      return result;
    });
  }
}
