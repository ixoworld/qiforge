import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { CodexRuntimeRegistry } from '../session/registry.js';
import { CodexController } from './codex.controller.js';
import { CODEX_REGISTRY } from './codex.tokens.js';

/** Stops every tenant's App Server when the Nest app shuts down. */
@Injectable()
export class CodexRegistryLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(CODEX_REGISTRY) private readonly registry: CodexRuntimeRegistry,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.registry.shutdown();
  }
}

/**
 * Plugin-owned HTTP surface. The registry instance is created by the plugin and
 * injected here, so the controller and the agent's tools drive the same
 * per-tenant sessions.
 */
@Module({})
export class CodexHttpModule {
  static register(registry: CodexRuntimeRegistry): DynamicModule {
    return {
      module: CodexHttpModule,
      controllers: [CodexController],
      providers: [
        { provide: CODEX_REGISTRY, useValue: registry },
        CodexRegistryLifecycle,
      ],
    };
  }
}
