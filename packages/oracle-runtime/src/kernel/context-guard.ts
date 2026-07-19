import type { Logger, RuntimeContext } from '../plugin-api/types.js';
import type {
  PermissionsEnforcement,
  PluginPermissions,
} from './permissions.js';

/** Thrown when a tool handler touches a surface its plugin never declared. */
export class PermissionDeniedError extends Error {
  constructor(
    readonly pluginName: string,
    readonly surface: string,
    readonly declareAs: string,
  ) {
    super(
      `Plugin '${pluginName}' accessed '${surface}' without declaring it. ` +
        `Add \`permissions: { ${declareAs} }\` to the plugin manifest.`,
    );
    this.name = 'PermissionDeniedError';
  }
}

export interface AttenuateContextOptions {
  pluginName: string;
  /** The plugin's manifest grant. `undefined` = nothing granted. */
  permissions: PluginPermissions | undefined;
  /** `enforce` throws on undeclared access; `warn` logs once and allows. */
  enforcement: PermissionsEnforcement;
  logger: Logger;
}

type GuardedMethod<A extends unknown[], R> = (...args: A) => R;

/**
 * Attenuate a fully-built `RuntimeContext` down to a plugin's declared
 * grant. Side-effect surfaces the plugin never declared are replaced with
 * guards that throw (`enforce`) or log-once-and-allow (`warn`); everything
 * without side-effect authority (identity, config, history, logger, user,
 * session, abortSignal, blob ids…) passes through untouched.
 *
 * The guard sits on the METHOD, not the object, so a denial names the exact
 * surface and the exact manifest line that would grant it — an error the
 * plugin author can act on directly.
 */
export function attenuateRuntimeContext(
  ctx: RuntimeContext,
  options: AttenuateContextOptions,
): RuntimeContext {
  const { pluginName, permissions, enforcement, logger } = options;
  const warned = new Set<string>();

  function guard<A extends unknown[], R>(
    granted: boolean,
    surface: string,
    declareAs: string,
    method: GuardedMethod<A, R>,
  ): GuardedMethod<A, R> {
    if (granted) return method;
    return (...args: A): R => {
      if (enforcement === 'warn') {
        if (!warned.has(surface)) {
          warned.add(surface);
          logger.warn(
            `[permissions] plugin '${pluginName}' used undeclared surface '${surface}' ` +
              `(enforcement=warn — declare \`permissions: { ${declareAs} }\` before this becomes an error)`,
          );
        }
        return method(...args);
      }
      throw new PermissionDeniedError(pluginName, surface, declareAs);
    };
  }

  const matrixRead = permissions?.matrix?.includes('read') === true;
  const matrixWrite = permissions?.matrix?.includes('write') === true;
  const secretsGranted = permissions?.secrets === true;
  const blobGranted = permissions?.blobStore === true;
  const invokeGranted = permissions?.ucan?.invoke === true;
  const selfSignGranted = permissions?.ucan?.selfSign === true;
  const llmGranted = permissions?.llm === true;
  const emitGranted = permissions?.emit === true;

  return {
    ...ctx,
    matrix: {
      postToRoom: guard(
        matrixWrite,
        'matrix.postToRoom',
        "matrix: ['write']",
        ctx.matrix.postToRoom,
      ),
      getRoomState: guard(
        matrixRead,
        'matrix.getRoomState',
        "matrix: ['read']",
        ctx.matrix.getRoomState,
      ),
      getEventById: guard(
        matrixRead,
        'matrix.getEventById',
        "matrix: ['read']",
        ctx.matrix.getEventById,
      ),
    },
    secrets: {
      getIndex: guard(
        secretsGranted,
        'secrets.getIndex',
        'secrets: true',
        ctx.secrets.getIndex,
      ),
      getValues: guard(
        secretsGranted,
        'secrets.getValues',
        'secrets: true',
        ctx.secrets.getValues,
      ),
    },
    blobStore: {
      put: guard(
        blobGranted,
        'blobStore.put',
        'blobStore: true',
        ctx.blobStore.put,
      ),
      get: guard(
        blobGranted,
        'blobStore.get',
        'blobStore: true',
        ctx.blobStore.get,
      ),
      // Format validation carries no authority — always available.
      isValidBlobId: ctx.blobStore.isValidBlobId,
    },
    ucan: {
      // Read-only helpers ride the invoke grant — they reveal delegation
      // shape, which is only useful to a plugin that mints against it.
      hasCapability: guard(
        invokeGranted,
        'ucan.hasCapability',
        'ucan: { invoke: true }',
        ctx.ucan.hasCapability,
      ),
      requireCapability: guard(
        invokeGranted,
        'ucan.requireCapability',
        'ucan: { invoke: true }',
        ctx.ucan.requireCapability,
      ),
      mintInvocation: guard(
        invokeGranted,
        'ucan.mintInvocation',
        'ucan: { invoke: true }',
        ctx.ucan.mintInvocation,
      ),
      resolveServiceDid: guard(
        invokeGranted,
        'ucan.resolveServiceDid',
        'ucan: { invoke: true }',
        ctx.ucan.resolveServiceDid,
      ),
      hasSigningKey: guard(
        invokeGranted,
        'ucan.hasSigningKey',
        'ucan: { invoke: true }',
        ctx.ucan.hasSigningKey,
      ),
      createInvocationFromDelegation: guard(
        invokeGranted,
        'ucan.createInvocationFromDelegation',
        'ucan: { invoke: true }',
        ctx.ucan.createInvocationFromDelegation,
      ),
      getServiceDelegation: guard(
        invokeGranted,
        'ucan.getServiceDelegation',
        'ucan: { invoke: true }',
        ctx.ucan.getServiceDelegation,
      ),
      // Oracle self-authority is its own grant — acting AS the oracle with
      // no user proof chain is the highest-authority primitive a plugin
      // can hold.
      mintSelfSignedInvocation: guard(
        selfSignGranted,
        'ucan.mintSelfSignedInvocation',
        'ucan: { selfSign: true }',
        ctx.ucan.mintSelfSignedInvocation,
      ),
    },
    llm: {
      get: guard(llmGranted, 'llm.get', 'llm: true', ctx.llm.get),
    },
    emit: {
      toolCall: guard(
        emitGranted,
        'emit.toolCall',
        'emit: true',
        ctx.emit.toolCall,
      ),
      actionCall: guard(
        emitGranted,
        'emit.actionCall',
        'emit: true',
        ctx.emit.actionCall,
      ),
      renderComponent: guard(
        emitGranted,
        'emit.renderComponent',
        'emit: true',
        ctx.emit.renderComponent,
      ),
      reasoning: guard(
        emitGranted,
        'emit.reasoning',
        'emit: true',
        ctx.emit.reasoning,
      ),
      browserToolCall: guard(
        emitGranted,
        'emit.browserToolCall',
        'emit: true',
        ctx.emit.browserToolCall,
      ),
      router: guard(emitGranted, 'emit.router', 'emit: true', ctx.emit.router),
      messageCacheInvalidation: guard(
        emitGranted,
        'emit.messageCacheInvalidation',
        'emit: true',
        ctx.emit.messageCacheInvalidation,
      ),
    },
  };
}
