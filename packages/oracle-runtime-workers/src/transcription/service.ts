import {
  TranscriptionBillingError,
  type TranscriptionBilling,
  type TranscriptionBillingAdmission,
} from './billing';
import {
  assertOrigin,
  CONNECT_TIMEOUT_MS,
  FINAL_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PCM_BYTES_PER_SECOND,
  ticketDigest,
  TICKET_TTL_MS,
  TranscriptionError,
  type TranscriptionEvent,
  type TranscriptionLimits,
} from './protocol';
import type {
  ProviderCallbacks,
  ProviderIdentifiers,
  TranscriptionProvider,
} from './provider';

export const TRANSCRIPTION_JOURNAL_KEY = 'transcription:session';
const DAILY_KEY = 'transcription:daily';
export const TRANSCRIPTION_INTENT_KEY = 'transcription:admission-intent';
// Central proposal's hold lifetime is 15 minutes; include one minute for a lost response.
const ADMISSION_RETRY_WINDOW_MS = 16 * 60_000;
export interface TranscriptionAdmissionIntent {
  sessionId: string;
  userDid: string;
  maxDurationMs: number;
  retryUntil: number;
}

/** Deliberately excludes audio, transcript, bearer credentials and tickets. */
export interface TranscriptionJournal extends ProviderIdentifiers {
  sessionId: string;
  userDid: string;
  origin: string;
  ticketHash: string;
  ticketExpiresAt: number;
  phase:
    | 'reserved'
    | 'listening'
    | 'finalizing'
    | 'pending'
    | 'settled'
    | 'reconciliation_required';
  admission: TranscriptionBillingAdmission;
  createdAt: number;
  day: string;
  reservedMs: number;
  audioBytes: number;
  durationSeconds?: number;
  occurredAt?: string;
  retryAt?: number;
}

interface DailyUsage {
  day: string;
  milliseconds: number;
}
export interface TranscriptionStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface ClientSink {
  send(event: TranscriptionEvent): void;
  close(): void;
  isClosed?(): boolean;
}
export interface TranscriptionServiceOptions {
  store: TranscriptionStore;
  billing: TranscriptionBilling;
  limits: TranscriptionLimits;
  connect(
    callbacks: ProviderCallbacks,
    signal: AbortSignal,
  ): Promise<TranscriptionProvider>;
  schedule(at: number): Promise<void>;
  now?: () => number;
}
interface LiveSession {
  id: string;
  sink: ClientSink;
  abort: AbortController;
  provider?: TranscriptionProvider;
  cancelled: boolean;
  closing: boolean;
  openedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  wallTimer?: ReturnType<typeof setTimeout>;
}

/** One service per user Durable Object. Serializes across async storage/network yields. */
export class TranscriptionService {
  private queue: Promise<unknown> = Promise.resolve();
  private live?: LiveSession;
  private readonly now: () => number;
  constructor(private readonly options: TranscriptionServiceOptions) {
    this.now = options.now ?? Date.now;
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private read() {
    return this.options.store.get<TranscriptionJournal>(
      TRANSCRIPTION_JOURNAL_KEY,
    );
  }
  private write(record: TranscriptionJournal) {
    return this.options.store.put(TRANSCRIPTION_JOURNAL_KEY, record);
  }

  create(
    userDid: string,
    sourceInvocation: string,
    origin: string | null,
    baseUrl: string,
  ) {
    return this.exclusive(async () => {
      const approvedOrigin = assertOrigin(origin, this.options.limits);
      await this.recover();
      const previous = await this.read();
      if (previous && previous.phase !== 'settled')
        throw new TranscriptionError('session_or_billing_pending', 409);
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const existing = await this.options.store.get<DailyUsage>(DAILY_KEY);
      const daily = existing?.day === day ? existing : { day, milliseconds: 0 };
      if (
        daily.milliseconds + this.options.limits.maxDurationMs >
        this.options.limits.maxDailyAudioMs
      )
        throw new TranscriptionError('daily_limit', 429);
      const pendingIntent =
        await this.options.store.get<TranscriptionAdmissionIntent | null>(
          TRANSCRIPTION_INTENT_KEY,
        );
      const intent: TranscriptionAdmissionIntent =
        pendingIntent && pendingIntent.retryUntil > this.now()
          ? pendingIntent
          : {
              sessionId: crypto.randomUUID(),
              userDid,
              maxDurationMs: this.options.limits.maxDurationMs,
              retryUntil: this.now() + ADMISSION_RETRY_WINDOW_MS,
            };
      if (
        intent.userDid !== userDid ||
        intent.maxDurationMs !== this.options.limits.maxDurationMs
      )
        throw new TranscriptionError('session_or_billing_pending', 409);
      const sessionId = intent.sessionId;
      // Stable intent precedes the remote side effect. Retries use fresh auth but
      // the SAME session/quote request; never strand successive capacity holds.
      await this.options.store.put(TRANSCRIPTION_INTENT_KEY, intent);
      await this.options.schedule(intent.retryUntil);
      const ticket = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const admission = await this.options.billing.admit({
        userDid,
        sourceInvocation,
        sessionId,
        maxAudioSeconds: this.options.limits.maxDurationMs / 1000,
      });
      const record: TranscriptionJournal = {
        sessionId,
        userDid,
        origin: approvedOrigin,
        ticketHash: await ticketDigest(ticket),
        ticketExpiresAt: this.now() + TICKET_TTL_MS,
        phase: 'reserved',
        admission,
        createdAt: this.now(),
        day,
        reservedMs: this.options.limits.maxDurationMs,
        audioBytes: 0,
      };
      try {
        // Conservative order: a storage failure can consume quota, never create free quota.
        await this.options.store.put(DAILY_KEY, {
          day,
          milliseconds: daily.milliseconds + record.reservedMs,
        });
        await this.write(record);
        await this.options.schedule(record.ticketExpiresAt);
        await this.options.store.put(TRANSCRIPTION_INTENT_KEY, null);
      } catch (error) {
        await this.options.billing.release({ admission }).then(
          () => this.options.store.put(TRANSCRIPTION_INTENT_KEY, null),
          () => undefined,
        );
        throw error;
      }
      const url = new URL('/transcription/socket', baseUrl);
      url.protocol = 'wss:';
      url.searchParams.set('userDid', userDid);
      url.searchParams.set('sessionId', sessionId);
      return {
        sessionId,
        ticket,
        websocketUrl: url.toString(),
        maxDurationMs: record.reservedMs,
        billing: { unit: 'second', metered: true },
      };
    });
  }

  /** Release only an unused admission; attached sockets own their own stop path. */
  cancelReservation(
    userDid: string,
    sessionId: string,
    origin: string | null,
  ): Promise<{ cancelled: boolean }> {
    return this.exclusive(async () => {
      assertOrigin(origin, this.options.limits);
      const record = await this.read();
      if (
        !record ||
        record.sessionId !== sessionId ||
        record.userDid !== userDid
      )
        return { cancelled: false };
      if (record.origin !== origin)
        throw new TranscriptionError('origin_forbidden', 403);
      if (
        this.live?.id === sessionId ||
        record.audioBytes !== 0 ||
        (record.phase !== 'reserved' &&
          !(
            (record.phase === 'pending' || record.phase === 'settled') &&
            record.durationSeconds === 0
          ))
      )
        throw new TranscriptionError('session_not_cancellable', 409);
      if (record.phase === 'settled') return { cancelled: true };
      if (record.phase === 'reserved') {
        record.ticketHash = '';
        await this.pending(record, 0);
      } else {
        // A retry may follow a crash between persisting pending and its alarm.
        record.retryAt = this.now() + 60_000;
        await this.write(record);
        await this.options.schedule(record.retryAt);
      }
      await this.settle(record);
      const result = await this.read();
      if (
        result?.phase !== 'settled' &&
        !(result?.phase === 'pending' && result.retryAt)
      )
        throw new TranscriptionError('session_or_billing_pending', 409);
      return { cancelled: true };
    });
  }

  attach(
    sessionId: string,
    ticket: string,
    origin: string | null,
    sink: ClientSink,
  ): Promise<void> {
    return this.exclusive(async () => {
      assertOrigin(origin, this.options.limits);
      if (sink.isClosed?.()) throw new TranscriptionError('cancelled');
      const record = await this.read();
      if (
        !record ||
        record.sessionId !== sessionId ||
        record.phase !== 'reserved' ||
        record.origin !== origin ||
        record.ticketExpiresAt <= this.now() ||
        ticket.length > 256 ||
        record.ticketHash !== (await ticketDigest(ticket))
      )
        throw new TranscriptionError('invalid_ticket', 401);
      if (sink.isClosed?.()) throw new TranscriptionError('cancelled');
      record.phase = 'listening';
      record.ticketHash = ''; // consumed before any upstream connection
      await this.write(record);
      if (sink.isClosed?.()) {
        await this.pending(record, 0);
        await this.settle(record);
        throw new TranscriptionError('cancelled');
      }
      const live: LiveSession = {
        id: sessionId,
        sink,
        abort: new AbortController(),
        cancelled: false,
        closing: false,
        openedAt: this.now(),
      };
      this.live = live;
      await this.options.schedule(
        this.now() +
          CONNECT_TIMEOUT_MS +
          record.reservedMs +
          2000 +
          FINAL_TIMEOUT_MS,
      );
      live.timer = setTimeout(() => live.abort.abort(), CONNECT_TIMEOUT_MS);
      try {
        live.provider = await this.options.connect(
          {
            identified: (ids) => {
              void this.identify(live, ids).catch(() =>
                this.emergencyClose(live),
              );
            },
            delta: (text) => {
              if (this.live === live && !live.cancelled && !live.closing)
                sink.send({ type: 'delta', text });
            },
            completed: (text, seconds) => {
              void this.complete(live, text, seconds).catch(() =>
                this.emergencyClose(live),
              );
            },
            failed: () => {
              void this.fail(sessionId, 'provider_unavailable').catch(() =>
                this.emergencyClose(live),
              );
            },
          },
          live.abort.signal,
        );
        if (live.abort.signal.aborted)
          throw new TranscriptionError('provider_unavailable');
        if (live.timer !== undefined) clearTimeout(live.timer);
        live.openedAt = this.now();
        this.resetIdle(live);
        live.wallTimer = setTimeout(() => {
          if (!live.cancelled)
            live.sink.send({ type: 'error', code: 'audio_limit' });
          void this.stop(sessionId, true).catch(() =>
            this.emergencyClose(live),
          );
        }, record.reservedMs + 2000);
        sink.send({ type: 'ready' });
      } catch {
        this.emergencyClose(live);
        await this.pending(record, 0);
        await this.settle(record);
        throw new TranscriptionError('provider_unavailable');
      }
    });
  }

  audio(sessionId: string, audio: ArrayBuffer): Promise<void> {
    return this.exclusive(async () => {
      const live = this.live;
      const record = await this.read();
      if (
        !live ||
        live.id !== sessionId ||
        !live.provider ||
        live.closing ||
        !record ||
        record.phase !== 'listening'
      )
        throw new TranscriptionError('invalid_state', 409);
      if (
        !audio.byteLength ||
        audio.byteLength % 2 ||
        audio.byteLength > MAX_FRAME_BYTES
      )
        throw new TranscriptionError('invalid_audio', 400);
      const bytes = record.audioBytes + audio.byteLength;
      const sampleMs = (bytes * 1000) / PCM_BYTES_PER_SECOND;
      if (
        sampleMs > record.reservedMs ||
        sampleMs > this.now() - live.openedAt + 2000
      )
        throw new TranscriptionError('audio_limit', 429);
      // Persist the upper bound before forwarding. A crash never silently refunds uncertain usage.
      record.audioBytes = bytes;
      await this.write(record);
      live.provider.append(audio);
      this.resetIdle(live);
    });
  }

  disconnect(sessionId: string, sink: ClientSink): Promise<void> {
    const live = this.live;
    if (!live || live.id !== sessionId || live.sink !== sink)
      return Promise.resolve();
    if (live.id === sessionId) {
      live.cancelled = true;
      if (!live.provider) live.abort.abort();
    }
    return this.stop(sessionId, true);
  }

  stop(sessionId: string, cancel: boolean): Promise<void> {
    return this.exclusive(async () => {
      const live = this.live;
      const record = await this.read();
      if (
        !live ||
        live.id !== sessionId ||
        !record ||
        record.sessionId !== sessionId
      )
        return;
      live.cancelled ||= cancel;
      if (live.closing) return;
      live.closing = true;
      if (live.timer !== undefined) clearTimeout(live.timer);
      if (live.wallTimer !== undefined) clearTimeout(live.wallTimer);
      if (!record.audioBytes) {
        await this.pending(record, 0);
        if (!live.cancelled) live.sink.send({ type: 'completed', text: '' });
        this.emergencyClose(live);
        await this.settle(record);
        return;
      }
      record.phase = 'finalizing';
      await this.write(record);
      live.timer = setTimeout(() => {
        void this.fail(sessionId, 'finalization_timeout').catch(() =>
          this.emergencyClose(live),
        );
      }, FINAL_TIMEOUT_MS);
      live.provider?.commit();
      // Cancellation discards text, but still obtains usage for the audio already processed.
    }).catch((error: unknown) => {
      const live = this.live;
      if (live?.id === sessionId) this.emergencyClose(live);
      throw error;
    });
  }

  fail(sessionId: string, code: string): Promise<void> {
    return this.exclusive(async () => {
      const record = await this.read();
      if (
        !record ||
        record.sessionId !== sessionId ||
        record.phase === 'settled' ||
        record.phase === 'pending'
      )
        return;
      const live = this.live;
      if (live?.id === sessionId) {
        if (!live.cancelled) live.sink.send({ type: 'error', code });
        this.emergencyClose(live);
      }
      if (record.audioBytes > 0) {
        record.phase = 'reconciliation_required';
        // No duration guess and no release of a hold for audio that may have incurred cost.
        await this.write(record);
      } else {
        await this.pending(record, 0);
        await this.settle(record);
      }
    });
  }

  private identify(
    live: LiveSession,
    identifiers: ProviderIdentifiers,
  ): Promise<void> {
    return this.exclusive(async () => {
      const record = await this.read();
      if (this.live !== live || !record || record.sessionId !== live.id) return;
      for (const key of [
        'providerSessionId',
        'providerItemId',
        'providerRequestId',
      ] as const) {
        const value = identifiers[key];
        if (value && /^[a-zA-Z0-9_-]{1,160}$/.test(value)) record[key] = value;
      }
      await this.write(record);
    });
  }

  private complete(
    live: LiveSession,
    text: string,
    durationSeconds: number,
  ): Promise<void> {
    return this.exclusive(async () => {
      const record = await this.read();
      if (this.live !== live || !record || record.phase !== 'finalizing')
        return;
      if (
        !Number.isFinite(durationSeconds) ||
        durationSeconds < 0 ||
        durationSeconds > record.reservedMs / 1000 ||
        durationSeconds > Math.ceil(record.audioBytes / PCM_BYTES_PER_SECOND)
      ) {
        record.phase = 'reconciliation_required';
        await this.write(record);
        if (!live.cancelled)
          live.sink.send({ type: 'error', code: 'usage_unavailable' });
        this.emergencyClose(live);
        return;
      }
      await this.pending(record, durationSeconds); // durable outbox + alarm before delivery/close
      if (!live.cancelled) live.sink.send({ type: 'completed', text });
      this.emergencyClose(live);
      await this.settle(record);
    });
  }

  private async pending(
    record: TranscriptionJournal,
    seconds: number,
  ): Promise<void> {
    record.phase = 'pending';
    record.durationSeconds = seconds;
    record.occurredAt = new Date(this.now()).toISOString();
    record.retryAt = this.now() + 60_000;
    await this.write(record);
    // Attach's durable watchdog covers a crash between these writes. Never close
    // the last live socket or await a billing request before a retry is armed.
    await this.options.schedule(record.retryAt);
  }

  private async settle(record: TranscriptionJournal): Promise<void> {
    if (record.durationSeconds === undefined || !record.occurredAt) return;
    if (
      record.durationSeconds > 0 &&
      this.now() >= Date.parse(record.admission.settleBy)
    ) {
      record.phase = 'reconciliation_required';
      delete record.retryAt;
      await this.write(record);
      return;
    }
    try {
      if (record.durationSeconds === 0)
        await this.options.billing.release({ admission: record.admission });
      else
        await this.options.billing.settle({
          admission: record.admission,
          measuredAudioSeconds: record.durationSeconds,
          occurredAt: record.occurredAt,
        });
    } catch (error) {
      if (error instanceof TranscriptionBillingError && !error.retryable) {
        record.phase = 'reconciliation_required';
        delete record.retryAt;
        await this.write(record);
        return;
      }
      record.phase = 'pending';
      record.retryAt = this.now() + 60_000;
      await this.write(record);
      await this.options.schedule(record.retryAt);
      return;
    }
    // Persist terminal status first: a crash can retain conservative daily quota,
    // but cannot refund the same reservation twice after idempotent settlement.
    record.phase = 'settled';
    delete record.retryAt;
    await this.write(record);
    const daily = await this.options.store.get<DailyUsage>(DAILY_KEY);
    if (daily?.day === record.day)
      await this.options.store.put(DAILY_KEY, {
        day: record.day,
        milliseconds: Math.max(
          0,
          daily.milliseconds -
            record.reservedMs +
            Math.ceil(record.durationSeconds * 1000),
        ),
      });
  }

  /** Called on alarms and admission; recovers durable outbox without tokens/audio. */
  tick(): Promise<number | null> {
    return this.exclusive(() => this.recover());
  }
  private async recover(): Promise<number | null> {
    const record = await this.read();
    if (
      !record ||
      record.phase === 'settled' ||
      record.phase === 'reconciliation_required'
    )
      return null;
    if (this.live?.id === record.sessionId) {
      return Math.max(
        this.now() + 1000,
        this.live.openedAt + record.reservedMs + 2000 + FINAL_TIMEOUT_MS,
      );
    }
    if (record.phase === 'reserved' && record.ticketExpiresAt > this.now())
      return record.ticketExpiresAt;
    if (record.phase === 'pending') {
      if (!record.retryAt || record.retryAt <= this.now())
        await this.settle(record);
    } else if (record.audioBytes > 0) {
      record.phase = 'reconciliation_required';
      await this.write(record);
    } else {
      await this.pending(record, 0);
      await this.settle(record);
    }
    return (await this.read())?.retryAt ?? null;
  }
  private resetIdle(live: LiveSession): void {
    if (live.timer !== undefined) clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      void this.stop(live.id, true).catch(() => this.emergencyClose(live));
    }, IDLE_TIMEOUT_MS);
  }
  private emergencyClose(live: LiveSession): void {
    if (live.timer !== undefined) clearTimeout(live.timer);
    if (live.wallTimer !== undefined) clearTimeout(live.wallTimer);
    if (this.live === live) this.live = undefined;
    try {
      live.abort.abort();
    } catch {
      /* already aborted */
    }
    try {
      live.provider?.close();
    } catch {
      /* socket already unavailable */
    }
    try {
      live.sink.close();
    } catch {
      /* already closed */
    }
  }
}
