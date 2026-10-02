import type { TurnIdentity } from '../do/contracts';
import type { TranscriptionEnvironment } from './config';
import {
  assertOrigin,
  jsonObject,
  readTranscriptionOrigins,
  TranscriptionError,
} from './protocol';
import {
  TRANSCRIPTION_JOURNAL_KEY,
  type TranscriptionJournal,
  type TranscriptionService,
  type TranscriptionStore,
} from './service';

/** Internal DO route: the authenticated shell overwrites both identity headers. */
export async function cancelTranscriptionReservation(
  request: Request,
  sessionId: string,
  options: {
    env: TranscriptionEnvironment;
    store: Pick<TranscriptionStore, 'get'>;
    ready(identity: TurnIdentity): Promise<void>;
    service(
      journal: TranscriptionJournal,
    ): Promise<Pick<TranscriptionService, 'cancelReservation'>>;
  },
): Promise<Response> {
  const userDid = request.headers.get('x-transcription-user');
  const identity = jsonObject(request.headers.get('x-identity') ?? '{}');
  if (!userDid || identity.userDid !== userDid)
    throw new TranscriptionError('unauthorized', 401);
  const origin = assertOrigin(request.headers.get('origin'), {
    allowedOrigins: readTranscriptionOrigins(options.env),
  });
  const journal = await options.store.get<TranscriptionJournal>(
    TRANSCRIPTION_JOURNAL_KEY,
  );
  let result = { cancelled: false };
  if (journal?.sessionId === sessionId && journal.userDid === userDid) {
    if (journal.origin !== origin)
      throw new TranscriptionError('origin_forbidden', 403);
    await options.ready({
      userDid,
      ...(typeof identity.ucanDelegation === 'string'
        ? { ucanDelegation: identity.ucanDelegation }
        : {}),
      ...(typeof identity.ucanDelegationExpiration === 'number'
        ? { ucanDelegationExpiration: identity.ucanDelegationExpiration }
        : {}),
    });
    // Journal-based recovery requires billing, but neither admission nor a provider key.
    const service = await options.service(journal);
    result = await service.cancelReservation(userDid, sessionId, origin);
  }
  return Response.json(result, {
    headers: { 'cache-control': 'no-store' },
  });
}
