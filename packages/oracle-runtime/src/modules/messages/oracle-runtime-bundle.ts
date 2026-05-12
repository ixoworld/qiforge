import { Injectable } from '@nestjs/common';
import type { MainAgentHooks } from '../../graph/main-agent-types.js';
import type {
  MergedConfig,
  OracleIdentity,
} from '../../plugin-api/types.js';
import type {
  ConfigSchemaRegistry,
  ManifestRegistry,
  MiddlewareRegistry,
  SharedStateRegistry,
  SubAgentRegistry,
  ToolRegistry,
} from '../../registries/index.js';
import type { AmbientServices } from '../../runtime-context/ambient.js';

/** Snapshot of everything `createMainAgent` needs at request time. */
export interface OracleRuntimeBundle {
  ambient: AmbientServices;
  registries: {
    tools: ToolRegistry;
    subAgents: SubAgentRegistry;
    middlewares: MiddlewareRegistry;
    manifests: ManifestRegistry;
    configSchema: ConfigSchemaRegistry;
    sharedState: SharedStateRegistry;
  };
  identity: OracleIdentity;
  config: MergedConfig;
  availablePlugins: ReadonlySet<string>;
  hooks?: MainAgentHooks;
}

/**
 * Empty-at-construction Nest provider populated by `createOracleApp` once
 * Nest's DI container is up and the ambient services are wired. Downstream
 * services (MessagesService, etc.) inject the holder and read the bundle
 * per request.
 *
 * The holder pattern exists because `AmbientServices` depends on Nest's DI
 * (UcanService, SecretsService) but `RuntimeAppModule` has to register
 * MessagesService BEFORE those services exist. The holder breaks the
 * chicken-and-egg.
 */
@Injectable()
export class OracleRuntimeBundleHolder {
  private bundle: OracleRuntimeBundle | null = null;

  populate(bundle: OracleRuntimeBundle): void {
    if (this.bundle !== null) {
      throw new Error(
        'OracleRuntimeBundleHolder.populate called twice — bundle is single-shot.',
      );
    }
    this.bundle = bundle;
  }

  get(): OracleRuntimeBundle {
    if (this.bundle === null) {
      throw new Error(
        'OracleRuntimeBundleHolder.get called before populate — createOracleApp must run first.',
      );
    }
    return this.bundle;
  }

  isReady(): boolean {
    return this.bundle !== null;
  }
}
