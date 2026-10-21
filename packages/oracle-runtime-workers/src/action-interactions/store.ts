import {
  ActionInteractionError,
  canonicalJson,
  interactionValuesDigest,
  InteractionSchema,
  InteractionReferenceSchema,
  type Interaction,
  type InteractionResult,
  type PrepareInteraction,
  type UpdateInteraction,
  type ReserveInteraction,
  type ObserveInteraction,
  type CheckClaimDispatch,
  type CheckDispatch,
  type JsonValue,
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
    owner.kind === 'flow-claim' ||
    owner.kind === 'flow-claim-block' ||
    owner.kind === 'flow-bid'
      ? {
          ...(owner.kind === 'flow-claim-block'
            ? { collectionId: owner.collectionId }
            : {}),
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
        owner.kind === 'flow-claim' ||
          owner.kind === 'flow-claim-block' ||
          owner.kind === 'flow-bid' ||
          owner.kind === 'approval'
          ? { owner: binding }
          : { sessionId, owner: binding },
      ),
    ),
  );
  return `interaction-owner:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Receipt checkpoints may add facts, but cannot erase an acknowledged effect. */
function extendsReceipt(
  previous: JsonValue,
  next: JsonValue | undefined,
): boolean {
  if (next === undefined) return false;
  if (Array.isArray(previous))
    return (
      Array.isArray(next) &&
      previous.every(
        (value, index) =>
          index < next.length && extendsReceipt(value, next[index]),
      )
    );
  if (previous !== null && typeof previous === 'object')
    return (
      next !== null &&
      typeof next === 'object' &&
      !Array.isArray(next) &&
      Object.entries(previous).every(
        ([key, value]) =>
          Object.hasOwn(next, key) && extendsReceipt(value, next[key]),
      )
    );
  return previous === next;
}

/** Personal drafts only. Execution and verified receipts remain owned by Flow. */
export class ActionInteractionStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly context: { oracleDid: string; userDid: string },
    private readonly now: () => number = Date.now,
  ) {}

  /** A dispatch precondition, never an authorization grant or an executor. */
  async checkClaimDispatch(input: CheckClaimDispatch) {
    return this.checkDispatch(input);
  }

  async checkDispatch(
    input: CheckDispatch,
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
        if (
          input.owner.kind === 'approval' ||
          input.cardRef ||
          input.operationKey
        )
          throw new ActionInteractionError(
            409,
            'review_required',
            'No matching managed draft exists for this owner',
          );
        return { allowed: true, managed: false };
      }
      const record = await this.load(tx, id);
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
          'This action has a managed draft; reopen and review its current operation',
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

  async listReferences(sessionId: string) {
    const records = await this.storage.list<unknown>({
      prefix: PREFIX,
      limit: 1000,
    });
    return Array.from(records.values())
      .map((value) => InteractionReferenceSchema.parse(value))
      .filter((record) => record.sessionId === sessionId);
  }

  async list(sessionId: string): Promise<Interaction[]> {
    const records = await this.storage.list<unknown>({
      prefix: PREFIX,
      limit: 1000,
    });
    const result: Interaction[] = [];
    let bytes = 0;
    for (const [key, raw] of records) {
      const metadata = InteractionSchema.parse(raw);
      if (metadata.sessionId === sessionId) {
        const record = await this.load(this.storage, key.slice(PREFIX.length));
        if (record) {
          bytes += new TextEncoder().encode(JSON.stringify(record)).byteLength;
          if (bytes > 8 * 1024 * 1024)
            throw new ActionInteractionError(
              413,
              'list_too_large',
              'Use reference listing and read individual interactions',
            );
          result.push(record);
        }
      }
    }
    return result;
  }

  private async load(
    storage: Pick<DurableObjectStorage, 'get'>,
    id: string,
  ): Promise<Interaction | undefined> {
    const raw = await storage.get<unknown>(`${PREFIX}${id}`);
    if (raw === undefined) return undefined;
    const record = InteractionSchema.parse(raw);
    const count = await storage.get<number>(`interaction-chunks:${id}`);
    if (!count) return record;
    const chunks: string[] = [];
    for (let index = 0; index < count; index++) {
      const chunk = await storage.get<string>(
        `interaction-value:${id}:${index}`,
      );
      if (chunk === undefined)
        throw new Error('Private interaction payload is incomplete');
      chunks.push(chunk);
    }
    return InteractionSchema.parse({
      ...record,
      values: JSON.parse(chunks.join('')),
    });
  }

  private async save(
    storage: Pick<DurableObjectStorage, 'put'>,
    record: Interaction,
  ): Promise<void> {
    const totalLimit =
      record.owner.kind === 'approval' && record.owner.family === 'domain-write'
        ? 2 * 1024 * 1024
        : 96 * 1024;
    if (
      new TextEncoder().encode(JSON.stringify(record)).byteLength > totalLimit
    )
      throw new ActionInteractionError(
        413,
        'too_large',
        'Interaction exceeds the owner record limit',
      );
    const payload = JSON.stringify(record.values);
    if (
      new TextEncoder().encode(JSON.stringify(record)).byteLength <=
      96 * 1024
    ) {
      await storage.put(`${PREFIX}${record.id}`, record);
      return;
    }
    // 24K UTF-16 units always encode below the 128KiB DO value ceiling.
    const chunks = Math.ceil(payload.length / (24 * 1024));
    for (let index = 0; index < chunks; index++)
      await storage.put(
        `interaction-value:${record.id}:${index}`,
        payload.slice(index * 24 * 1024, (index + 1) * 24 * 1024),
      );
    await storage.put(`interaction-chunks:${record.id}`, chunks);
    await storage.put(`${PREFIX}${record.id}`, { ...record, values: {} });
  }

  private checkSize(
    values: Interaction['values'],
    owner: Interaction['owner'],
  ) {
    const limit =
      owner.kind === 'approval' && owner.family === 'domain-write'
        ? 2 * 1024 * 1024 - 16 * 1024
        : 64 * 1024;
    if (new TextEncoder().encode(canonicalJson(values)).byteLength > limit)
      throw new ActionInteractionError(
        413,
        'too_large',
        'Draft values exceed the owner payload limit',
      );
  }

  private async readFrom(
    storage: Pick<DurableObjectStorage, 'get'>,
    id: string,
    sessionId: string,
  ): Promise<Interaction> {
    const record = await this.load(storage, id);
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
          if (
            input.owner.kind === 'approval' &&
            canonicalJson(existing.values) !== canonicalJson(input.values)
          )
            throw new ActionInteractionError(
              409,
              'request_conflict',
              'Approval request identity already binds different values',
            );
          await tx.put(requestKey, { fingerprint, id: existing.id });
          return { interaction: existing, replayed: true };
        }
        if (
          'accountDid' in input.owner &&
          input.owner.accountDid !== this.context.userDid
        )
          throw new ActionInteractionError(
            403,
            'account_mismatch',
            'Claim account differs from authenticated user',
          );
        this.checkSize(input.values, input.owner);
        if (
          input.owner.kind === 'approval' &&
          (!input.values.request ||
            typeof input.values.request !== 'object' ||
            Array.isArray(input.values.request) ||
            Object.keys(input.values).length !== 1)
        )
          throw new ActionInteractionError(
            400,
            'invalid_request',
            'Approval values must contain exactly one request object',
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
              if (record.owner.kind === 'approval')
                throw new ActionInteractionError(
                  409,
                  'immutable_request',
                  'Approval requests cannot be changed after preparation',
                );
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
              this.checkSize(merged, record.owner);
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
            if (
              ![
                'flow-claim',
                'flow-claim-block',
                'flow-bid',
                'approval',
              ].includes(record.owner.kind) ||
              record.status !== 'draft'
            )
              throw new ActionInteractionError(
                409,
                'not_dispatchable',
                'Only an unreserved executable draft can be reserved',
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
              record.receipt &&
              command.input.receipt &&
              !extendsReceipt(record.receipt, command.input.receipt)
            )
              throw new ActionInteractionError(
                409,
                'receipt_conflict',
                'Receipt checkpoints cannot remove or change acknowledged effects',
              );
            if (
              command.input.receipt &&
              new TextEncoder().encode(canonicalJson(command.input.receipt))
                .byteLength >
                64 * 1024
            )
              throw new ActionInteractionError(
                413,
                'too_large',
                'Receipt exceeds 64 KiB',
              );
            if (
              !record.reservation ||
              record.reservation.operationKey !== command.input.operationKey ||
              !['reserved', 'outcome-unknown', 'partial'].includes(
                record.status,
              )
            )
              throw new ActionInteractionError(
                409,
                'reservation_mismatch',
                'No matching pending reservation',
              );
            record =
              command.input.outcome === 'unknown'
                ? {
                    ...record,
                    status: 'outcome-unknown',
                    ...(command.input.receipt
                      ? { receipt: command.input.receipt }
                      : {}),
                  }
                : {
                    ...record,
                    status:
                      command.input.outcome === 'partial'
                        ? 'partial'
                        : 'observed',
                    ...(command.input.receipt
                      ? { receipt: command.input.receipt }
                      : {}),
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
      await this.save(tx, record);
      await tx.put(requestKey, { fingerprint, id: record.id });
      return result;
    });
  }
}
