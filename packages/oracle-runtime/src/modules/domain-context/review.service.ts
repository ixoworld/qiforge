/**
 * @fileoverview Human review: raising an escalation, and honouring an approval.
 *
 * `manual_review_required` is the outcome that says a person has to decide.
 * On its own that is only a refusal with a nicer name — the loop closes only
 * when a human can answer and the answer can be verified. This service is
 * both halves.
 *
 * ## Raising
 *
 * The escalation is posted to the room the constitution names in
 * `agents[].escalation.matrix_room`. That is where a steward is actually
 * watching, and — unlike a websocket event — it survives the session ending,
 * which is the normal case for something a person has to think about.
 *
 * It carries the **request digest**: the action, on the object, for the
 * value. Not the tool (that would approve every future call to it) and not
 * the decision (the retry produces a different one). What a person approves
 * is the thing they were shown.
 *
 * ## Approving
 *
 * An approval is a Matrix **state event** in the escalation room, keyed by
 * the digest. State is the right shape twice over: it is idempotent, so a
 * reviewer who clicks twice approves once, and writing it requires power in
 * the room, so Matrix's own access control is the first gate on who may
 * approve at all.
 *
 * On top of that, one rule this service enforces itself: **the entity cannot
 * approve its own escalation.** An approval sent by the oracle's own Matrix
 * user is rejected however well-formed it is. Generation and determination
 * stay separate principals, and an entity that could sign off its own
 * escalations would have a review step in name only — the one direction a
 * compromised model would push hardest on.
 */
import type { DomainContext } from '../../constitution/domain-context.js';
import type { EscalationSubject } from '../../graph/middlewares/constitution-gate-middleware.js';
import type { Logger } from '../../plugin-api/types.js';

/** Posted by the runtime when an action needs a person. */
export const ESCALATION_EVENT_TYPE = 'ixo.constitution.escalation';

/** Written by a reviewer to approve one specific request. */
export const APPROVAL_EVENT_TYPE = 'ixo.constitution.approval';

/** How long an approval read from the room is trusted without re-reading. */
const APPROVAL_CACHE_TTL_MS = 30_000;

export interface ReviewTransport {
  sendEvent(roomId: string, type: string, content: object): Promise<string>;
  /** Room state, as `{type, state_key, sender, content}` records. */
  getRoomState(roomId: string): Promise<readonly RoomStateEvent[]>;
}

export interface RoomStateEvent {
  type: string;
  state_key: string;
  sender: string;
  content: Record<string, unknown>;
}

export interface ConstitutionReviewOptions {
  domain: DomainContext;
  transport: ReviewTransport;
  logger: Logger;
  /**
   * The oracle's own Matrix user id. An approval from this sender is refused:
   * the entity does not review itself.
   */
  selfMatrixUserId: string | null;
  now?: () => number;
  cacheTtlMs?: number;
}

interface CachedApprovals {
  readAt: number;
  bySubject: Map<string, string>;
}

export class ConstitutionReviewService {
  private readonly domain: DomainContext;

  private readonly transport: ReviewTransport;

  private readonly logger: Logger;

  private readonly selfMatrixUserId: string | null;

  private readonly now: () => number;

  private readonly cacheTtlMs: number;

  private cache: CachedApprovals | null = null;

  /** Digests already raised, so a retry loop does not spam the reviewer. */
  private readonly raised = new Set<string>();

  constructor(options: ConstitutionReviewOptions) {
    this.domain = options.domain;
    this.transport = options.transport;
    this.logger = options.logger;
    this.selfMatrixUserId = options.selfMatrixUserId;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? APPROVAL_CACHE_TTL_MS;
  }

  /** The room escalations go to, per the constitution. Null when none declared. */
  get room(): string | null {
    return this.domain.advisory.escalationRoom;
  }

  /**
   * The approval covering this request, if a reviewer has left one.
   *
   * Returns the approving reviewer's id, which becomes the proof reference on
   * the decision record — "who said yes" is the part worth keeping.
   */
  async findApproval(requestDigest: string): Promise<string | null> {
    const approvals = await this.approvals();
    return approvals.get(requestDigest) ?? null;
  }

  /**
   * Confirms a proof reference still covers this exact request.
   *
   * Re-read rather than trusted from the caller: the reference travels
   * through `AuthorizationRequest`, and a verifier that took its word for it
   * would approve anything that could put a string in that field.
   */
  async verifyProof(ref: string, requestDigest?: string): Promise<boolean> {
    if (!requestDigest) return false;
    const approver = await this.findApproval(requestDigest);
    return approver !== null && approver === ref;
  }

  /**
   * Raises an escalation for an action a person has to decide.
   *
   * Idempotent per request digest for the life of the process: the model will
   * be told to raise it and may well try the same action again, and a
   * reviewer facing forty identical requests reads none of them.
   */
  async escalate(subject: EscalationSubject): Promise<void> {
    const room = this.room;
    if (!room) {
      this.logger.warn(
        `[constitution] ${subject.toolName} needs human review, but the constitution declares no escalation room. ` +
          'Nobody will see this. (event: constitution.escalation.undeliverable)',
      );
      return;
    }
    if (this.raised.has(subject.requestDigest)) return;
    this.raised.add(subject.requestDigest);

    try {
      await this.transport.sendEvent(room, ESCALATION_EVENT_TYPE, {
        entity: this.domain.subject,
        entity_type: this.domain.entityType,
        agent: this.domain.agentId,
        constitution: `${this.domain.domainMdCid}@${this.domain.documentRevision}`,
        request_digest: subject.requestDigest,
        tool: subject.toolName,
        action: subject.action,
        operation: subject.operation,
        object: subject.object,
        value: subject.value,
        reason_codes: [...subject.reasonCodes],
        rule_refs: [...subject.ruleRefs],
        session_id: subject.sessionId,
        reviewer_role: this.domain.advisory.escalationRole,
        // Told to the reviewer rather than left implicit: approving means
        // writing this state event with this key, and nothing else counts.
        approve_with: {
          type: APPROVAL_EVENT_TYPE,
          state_key: subject.requestDigest,
          content: { request_digest: subject.requestDigest },
        },
      });
    } catch (error) {
      // Allow a later attempt to raise it again — the reviewer never saw this
      // one, so suppressing the repeat would lose it entirely.
      this.raised.delete(subject.requestDigest);
      this.logger.error(
        `[constitution] Could not raise an escalation for ${subject.toolName}`,
        error,
      );
    }
  }

  /** Drops the cached room read, so the next lookup sees fresh approvals. */
  invalidate(): void {
    this.cache = null;
  }

  private async approvals(): Promise<Map<string, string>> {
    const room = this.room;
    if (!room) return new Map();

    const cached = this.cache;
    if (cached && this.now() - cached.readAt < this.cacheTtlMs) {
      return cached.bySubject;
    }

    const bySubject = new Map<string, string>();
    try {
      for (const event of await this.transport.getRoomState(room)) {
        if (event.type !== APPROVAL_EVENT_TYPE) continue;
        // Redacted or withdrawn approvals come back as empty content.
        if (Object.keys(event.content).length === 0) continue;

        // The state key is the digest, and the content has to agree with it.
        // Without this check an approval for one action could be filed under
        // the key of another.
        if (event.content.request_digest !== event.state_key) {
          this.logger.warn(
            `[constitution] Ignoring an approval whose content names a different request than its key (${event.state_key}).`,
          );
          continue;
        }

        // The entity does not review itself. This is the one direction a
        // compromised model would push hardest on, and it is refused here
        // regardless of how well-formed the event is.
        if (
          this.selfMatrixUserId !== null &&
          event.sender === this.selfMatrixUserId
        ) {
          this.logger.error(
            `[constitution] Refusing a self-issued approval for ${event.state_key}: ` +
              'the entity cannot approve its own escalation. ' +
              '(event: constitution.approval.self_issued)',
          );
          continue;
        }

        bySubject.set(event.state_key, event.sender);
      }
    } catch (error) {
      // An unreadable room is not an approving one.
      this.logger.warn(
        '[constitution] Could not read approvals from the escalation room',
        error,
      );
      return new Map();
    }

    this.cache = { readAt: this.now(), bySubject };
    return bySubject;
  }
}
