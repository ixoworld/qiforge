/**
 * @fileoverview Holds the constitution the runtime booted with, so anything
 * inside Nest can read it without re-reading the document.
 *
 * The service is a holder, not a loader. Loading happens in `createOracleApp`
 * before Nest is constructed, because a document that fails its checks must
 * stop the boot rather than surface as a runtime error on the first tool call.
 * By the time this service exists, the question of whether there is a valid
 * constitution has already been settled.
 */
import { Injectable } from '@nestjs/common';
import type { DomainContext } from '../../constitution/domain-context.js';

/**
 * Provider token for the frozen `DomainContext`.
 *
 * A token rather than a class because the value is built at boot and injected,
 * not constructed by Nest.
 */
export const DOMAIN_CONTEXT = Symbol('DOMAIN_CONTEXT');

@Injectable()
export class DomainContextService {
  constructor(private readonly context: DomainContext) {}

  /** The constitution in force. Frozen — callers cannot alter what governs them. */
  get(): DomainContext {
    return this.context;
  }
}
