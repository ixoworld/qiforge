/**
 * @fileoverview Makes the entity's constitution available everywhere inside
 * Nest.
 *
 * `@Global` for the same reason as the UCAN module: the gate, the prompt
 * composer and the decision recorder all need it, they sit in unrelated parts
 * of the tree, and threading an import through every one of them would make
 * the constitution look optional to whichever module forgot.
 */
import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { DomainContext } from '../../constitution/domain-context.js';
import {
  DOMAIN_CONTEXT,
  DomainContextService,
} from './domain-context.service.js';

@Global()
@Module({})
export class DomainContextModule {
  /**
   * Binds the already-loaded constitution into the container.
   *
   * Takes the context rather than a path: loading it here would mean a
   * document failing its checks throws during module construction, where the
   * message competes with a Nest dependency-resolution stack trace instead of
   * reading as the boot refusal it is.
   */
  static register(context: DomainContext): DynamicModule {
    return {
      module: DomainContextModule,
      providers: [
        { provide: DOMAIN_CONTEXT, useValue: context },
        {
          provide: DomainContextService,
          useFactory: (ctx: DomainContext) => new DomainContextService(ctx),
          inject: [DOMAIN_CONTEXT],
        },
      ],
      exports: [DomainContextService, DOMAIN_CONTEXT],
    };
  }
}
